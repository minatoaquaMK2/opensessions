import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { DevinAgentWatcher, determineStatus } from "../src/agents/watchers/devin";
import type { AgentEvent } from "../src/contracts/agent";
import type { AgentWatcherContext } from "../src/contracts/agent-watcher";

// --- determineStatus ---

describe("Devin determineStatus", () => {
  test("returns idle for null message", () => {
    expect(determineStatus(null)).toBe("idle");
  });

  test("returns idle for message with no role", () => {
    expect(determineStatus({})).toBe("idle");
  });

  test("user message → running", () => {
    expect(determineStatus({ role: "user" })).toBe("running");
  });

  test("tool message → running", () => {
    expect(determineStatus({ role: "tool" })).toBe("running");
  });

  test("assistant streaming (no finish_reason) → running", () => {
    expect(determineStatus({ role: "assistant" })).toBe("running");
  });

  test("assistant + finish_reason=tool_calls → running", () => {
    expect(determineStatus({
      role: "assistant",
      metadata: { finish_reason: "tool_calls" },
    })).toBe("running");
  });

  test("assistant + finish_reason=stop → done", () => {
    expect(determineStatus({
      role: "assistant",
      metadata: { finish_reason: "stop" },
    })).toBe("done");
  });

  test("assistant + finish_reason=error → error", () => {
    expect(determineStatus({
      role: "assistant",
      metadata: { finish_reason: "error" },
    })).toBe("error");
  });

  test("assistant + finish_reason=length → done", () => {
    expect(determineStatus({
      role: "assistant",
      metadata: { finish_reason: "length" },
    })).toBe("done");
  });

  test("system + interrupt content → interrupted", () => {
    expect(determineStatus({
      role: "system",
      content: "[Response interrupted by user]",
    })).toBe("interrupted");
  });

  test("system + system prompt content → idle (skip)", () => {
    expect(determineStatus({
      role: "system",
      content: "You are powered by Claude Opus 4.6...",
    })).toBe("idle");
  });

  test("assistant content with interrupt marker → interrupted", () => {
    expect(determineStatus({
      role: "assistant",
      content: "[Response interrupted by user]",
      metadata: { finish_reason: null },
    })).toBe("interrupted");
  });

  test("array content with interrupt text → interrupted", () => {
    expect(determineStatus({
      role: "system",
      content: [{ type: "text", text: "[Response interrupted by user]" }],
    })).toBe("interrupted");
  });

  test("unknown role → idle", () => {
    expect(determineStatus({ role: "weird" })).toBe("idle");
  });
});

// --- DevinAgentWatcher integration ---

describe("DevinAgentWatcher", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: InstanceType<typeof Database>;
  let watcher: DevinAgentWatcher;
  let events: AgentEvent[];
  let ctx: AgentWatcherContext;

  function createDb() {
    db = new Database(dbPath);
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT NOT NULL,
      backend_type TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      agent_mode TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      title TEXT,
      main_chain_id INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL,
      parent_node_id INTEGER,
      chat_message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      metadata TEXT,
      UNIQUE(session_id, node_id)
    )`);
  }

  function insertSession(
    id: string,
    workingDir: string,
    title: string | null,
    mainChainId: number | null,
    lastActivitySec = Math.floor(Date.now() / 1000),
    hidden = 0,
  ) {
    db.run(
      `INSERT OR REPLACE INTO sessions (id, working_directory, created_at, last_activity_at, title, main_chain_id, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, workingDir, lastActivitySec - 10, lastActivitySec, title, mainChainId, hidden],
    );
  }

  function insertNode(sessionId: string, nodeId: number, parent: number | null, chatMessage: object, createdAtSec = Math.floor(Date.now() / 1000)) {
    db.run(
      `INSERT OR REPLACE INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, nodeId, parent, JSON.stringify(chatMessage), createdAtSec],
    );
  }

  function bumpActivity(sessionId: string, lastActivitySec = Math.floor(Date.now() / 1000)) {
    db.run(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`, [lastActivitySec, sessionId]);
  }

  beforeEach(() => {
    tmpDir = join(tmpdir(), `devin-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, "sessions.db");
    createDb();
    events = [];
    ctx = {
      resolveSession: (dir) => dir === "/projects/myapp" ? "myapp-session" : null,
      emit: (event) => events.push(event),
    };
    watcher = new DevinAgentWatcher();
    (watcher as any).dbPath = dbPath;
  });

  afterEach(() => {
    watcher.stop();
    try { db.close(); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("seed scan emits running for active session with assistant streaming", async () => {
    insertSession("zesty-zebra", "/projects/myapp", "First task", 2);
    insertNode("zesty-zebra", 1, null, { role: "user", content: "do thing" });
    insertNode("zesty-zebra", 2, 1, { role: "assistant", content: "" }); // streaming, no finish_reason

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(1);
    expect(events[0]!.agent).toBe("devin");
    expect(events[0]!.session).toBe("myapp-session");
    expect(events[0]!.status).toBe("running");
    expect(events[0]!.threadName).toBe("First task");
    expect(events[0]!.threadId).toBe("zesty-zebra");
  });

  test("seed scan emits done for completed session", async () => {
    insertSession("done-deer", "/projects/myapp", "Completed task", 2);
    insertNode("done-deer", 1, null, { role: "user", content: "do thing" });
    insertNode("done-deer", 2, 1, { role: "assistant", content: "ok", metadata: { finish_reason: "stop" } });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe("done");
  });

  test("seed scan emits interrupted for system interrupt", async () => {
    insertSession("aborted-ape", "/projects/myapp", "Aborted task", 3);
    insertNode("aborted-ape", 1, null, { role: "user", content: "do thing" });
    insertNode("aborted-ape", 2, 1, { role: "assistant", content: "starting" });
    insertNode("aborted-ape", 3, 2, { role: "system", content: "[Response interrupted by user]" });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe("interrupted");
  });

  test("skips session whose working_directory cannot be resolved", async () => {
    insertSession("unmapped", "/some/random/path", "Stray", 1);
    insertNode("unmapped", 1, null, { role: "user", content: "..." });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(0);
  });

  test("skips hidden sessions", async () => {
    insertSession("hidden-hippo", "/projects/myapp", "Hidden", 1, undefined, 1);
    insertNode("hidden-hippo", 1, null, { role: "user", content: "..." });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(0);
  });

  test("skips sessions older than STALE_SEC", async () => {
    const ancient = Math.floor(Date.now() / 1000) - 6 * 60; // 6 minutes ago
    insertSession("ancient-aardvark", "/projects/myapp", "Old", 1, ancient);
    insertNode("ancient-aardvark", 1, null, { role: "user", content: "..." });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(0);
  });

  test("emits status change when session transitions running → done", async () => {
    const start = Math.floor(Date.now() / 1000);
    insertSession("trans-tiger", "/projects/myapp", "Transition", 2, start);
    insertNode("trans-tiger", 1, null, { role: "user", content: "..." });
    insertNode("trans-tiger", 2, 1, { role: "assistant", content: "" }); // streaming

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));
    const seedCount = events.length;

    // Now session completes — head node updated to finish_reason=stop
    insertNode("trans-tiger", 2, 1, {
      role: "assistant",
      content: "done",
      metadata: { finish_reason: "stop" },
    });
    bumpActivity("trans-tiger", start + 5);

    await new Promise((r) => setTimeout(r, 3500));

    const post = events.slice(seedCount);
    expect(post.length).toBeGreaterThanOrEqual(1);
    expect(post[0]!.status).toBe("done");
  });

  test("emits running through tool-use cycle (no spurious done)", async () => {
    const start = Math.floor(Date.now() / 1000);
    insertSession("tool-toad", "/projects/myapp", "Tool cycle", 2, start);
    insertNode("tool-toad", 1, null, { role: "user", content: "fetch" });
    insertNode("tool-toad", 2, 1, { role: "assistant", content: "" });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));
    const seedCount = events.length;

    // Step 1: assistant calls tools (running → still running)
    insertNode("tool-toad", 2, 1, {
      role: "assistant",
      content: "calling",
      metadata: { finish_reason: "tool_calls" },
    });
    db.run(`UPDATE sessions SET main_chain_id = ?, last_activity_at = ? WHERE id = ?`, [2, start + 5, "tool-toad"]);
    await new Promise((r) => setTimeout(r, 500));

    // Step 2: tool result (running)
    insertNode("tool-toad", 3, 2, { role: "tool", content: "ok" });
    db.run(`UPDATE sessions SET main_chain_id = ?, last_activity_at = ? WHERE id = ?`, [3, start + 10, "tool-toad"]);
    await new Promise((r) => setTimeout(r, 3500));

    const post = events.slice(seedCount);
    const doneEvents = post.filter((e) => e.status === "done");
    expect(doneEvents.length).toBe(0);
  });

  test("promotes stuck running to stale when activity stops advancing", async () => {
    insertSession("stuck-stork", "/projects/myapp", "Stuck", 1);
    insertNode("stuck-stork", 1, null, { role: "user", content: "..." });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));
    const seedCount = events.length;

    // Backdate lastGrowthAt to simulate process killed 16s ago
    const snapshot = (watcher as any).sessions.get("stuck-stork");
    snapshot.lastGrowthAt = Date.now() - 16_000;

    await new Promise((r) => setTimeout(r, 3500));

    const stale = events.slice(seedCount).filter((e) => e.status === "stale");
    expect(stale.length).toBeGreaterThanOrEqual(1);
  }, 10_000);

  test("emits title update when title appears for the first time", async () => {
    const start = Math.floor(Date.now() / 1000);
    insertSession("untitled-ungulate", "/projects/myapp", null, 1, start);
    insertNode("untitled-ungulate", 1, null, { role: "user", content: "hi" });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));
    events = [];

    // Advance last_activity_at by at least one second (DB column is seconds-precision)
    db.run(`UPDATE sessions SET title = ?, last_activity_at = ? WHERE id = ?`, [
      "Generated title",
      start + 5,
      "untitled-ungulate",
    ]);

    await new Promise((r) => setTimeout(r, 3500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.threadName).toBe("Generated title");
    expect(events[0]!.status).toBe("running");
  });

  test("does not emit when nothing meaningful changed", async () => {
    insertSession("steady-stoat", "/projects/myapp", "Steady", 1);
    insertNode("steady-stoat", 1, null, { role: "user", content: "..." });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));
    events = [];

    // Bump activity but keep status + title the same
    bumpActivity("steady-stoat", Math.floor(Date.now() / 1000) + 1);

    await new Promise((r) => setTimeout(r, 3500));

    expect(events.length).toBe(0);
  });

  test("emits for brand-new sessions appearing after seed", async () => {
    // Seed empty — no sessions yet
    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));
    expect(events.length).toBe(0);

    // New session appears post-seed (e.g. user just started `devin -p`)
    insertSession("late-llama", "/projects/myapp", "Late session", 1);
    insertNode("late-llama", 1, null, { role: "user", content: "..." });

    await new Promise((r) => setTimeout(r, 3500));

    // Brand-new post-seed sessions are user-visible activity that should
    // appear in the sidebar, so the watcher emits on first detection
    // (as long as the head-node status is non-idle).
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.threadId).toBe("late-llama");
    expect(events[0]!.status).toBe("running");
  });

  test("reseeds and emits active sessions after stop/start restart", async () => {
    insertSession("restart-raven", "/projects/myapp", "Restarted", 1);
    insertNode("restart-raven", 1, null, { role: "user", content: "..." });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));
    expect(events.length).toBe(1);

    watcher.stop();
    events = [];

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(1);
    expect(events[0]!.threadId).toBe("restart-raven");
    expect(events[0]!.status).toBe("running");
  });

  test("does not emit for new post-seed sessions stuck on a system prompt (idle)", async () => {
    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));
    expect(events.length).toBe(0);

    // Session whose head node is just a system prompt — not actual activity
    insertSession("syslog-sloth", "/projects/myapp", "System only", 1);
    insertNode("syslog-sloth", 1, null, {
      role: "system",
      content: "You are powered by ...",
    });

    await new Promise((r) => setTimeout(r, 3500));

    expect(events.length).toBe(0);
  });

  test("recovers from DB errors by reopening", async () => {
    const start = Math.floor(Date.now() / 1000);
    insertSession("recover-rabbit", "/projects/myapp", "Recovery", 1, start);
    insertNode("recover-rabbit", 1, null, { role: "user", content: "..." });

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));

    db.close();
    createDb();
    // Advance the timestamp on the recreated row so the watcher detects a change
    insertSession("recover-rabbit", "/projects/myapp", "Recovery", 2, start + 5);
    insertNode("recover-rabbit", 1, null, { role: "user", content: "..." });
    insertNode("recover-rabbit", 2, 1, { role: "assistant", content: "ok", metadata: { finish_reason: "stop" } });

    (watcher as any).db = null;

    await new Promise((r) => setTimeout(r, 3500));

    const doneEvents = events.filter((e) => e.status === "done");
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("handles missing main_chain_id gracefully (idle, no emit)", async () => {
    insertSession("no-chain", "/projects/myapp", "No chain", null);

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(0);
  });

  test("handles missing head node gracefully (idle, no emit)", async () => {
    insertSession("phantom-chain", "/projects/myapp", "Phantom", 99);
    // No corresponding node row for node_id=99

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(0);
  });
});
