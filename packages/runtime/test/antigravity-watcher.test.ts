import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  AntigravityAgentWatcher,
  parseHistoryEntry,
  parseLogSignal,
} from "../src/agents/watchers/antigravity";
import type { AgentEvent } from "../src/contracts/agent";
import type { AgentWatcherContext } from "../src/contracts/agent-watcher";

describe("Antigravity parser helpers", () => {
  test("parses history entries with conversation and workspace", () => {
    const entry = parseHistoryEntry(JSON.stringify({
      display: "Build a thing",
      timestamp: 123,
      workspace: "/projects/myapp",
      conversationId: "conv-1",
    }));

    expect(entry?.conversationId).toBe("conv-1");
    expect(entry?.workspace).toBe("/projects/myapp");
  });

  test("ignores invalid history entries", () => {
    expect(parseHistoryEntry("not-json")).toBeNull();
    expect(parseHistoryEntry(JSON.stringify({ display: "missing id" }))).toBeNull();
  });

  test("parses prompt input log lines", () => {
    const signal = parseLogSignal(`I0520 input_loop.go:34] HandleUserInput called with text: "hello\\nworld"`);

    expect(signal).toEqual({ type: "input", threadName: "hello" });
  });

  test("parses conversation and status log lines", () => {
    expect(parseLogSignal("conversation_manager.go:316] Forwarding user message to conversation abc-123 (items=1)"))
      .toEqual({ type: "conversation", conversationId: "abc-123" });
    expect(parseLogSignal("server.go:747] Created conversation abc-123"))
      .toEqual({ type: "context", conversationId: "abc-123" });
    expect(parseLogSignal("text_drip.go:173] Drip stopped: lastStepIdx=1"))
      .toEqual({ type: "status", status: "done" });
    expect(parseLogSignal("conversation_manager.go:726] Cancelling in-progress response for conversation abc-123"))
      .toEqual({ type: "status", status: "interrupted", conversationId: "abc-123" });
  });
});

describe("AntigravityAgentWatcher", () => {
  let tmpDir: string;
  let watcher: AntigravityAgentWatcher;
  let events: AgentEvent[];
  let ctx: AgentWatcherContext;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `antigravity-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, "log"), { recursive: true });
    events = [];
    ctx = {
      resolveSession: (dir) => dir === "/projects/myapp" ? "myapp-session" : null,
      emit: (event) => events.push(event),
    };
    watcher = new AntigravityAgentWatcher();
    (watcher as any).appDataDir = tmpDir;
  });

  afterEach(() => {
    watcher.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("seed scan emits running for recent history entry", async () => {
    writeFileSync(join(tmpDir, "history.jsonl"), JSON.stringify({
      display: "Build support",
      timestamp: Date.now(),
      workspace: "/projects/myapp",
      conversationId: "conv-1",
    }) + "\n");

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 150));

    expect(events).toHaveLength(1);
    expect(events[0]!.agent).toBe("antigravity");
    expect(events[0]!.session).toBe("myapp-session");
    expect(events[0]!.status).toBe("running");
    expect(events[0]!.threadId).toBe("conv-1");
    expect(events[0]!.threadName).toBe("Build support");
  });

  test("seed scan does not refresh old history from existing completion logs", async () => {
    writeFileSync(join(tmpDir, "history.jsonl"), JSON.stringify({
      display: "Old support",
      timestamp: Date.now() - 60 * 60 * 1000,
      workspace: "/projects/myapp",
      conversationId: "conv-old",
    }) + "\n");
    writeFileSync(join(tmpDir, "log", "cli.log"), "I0520 text_drip.go:173] Drip stopped: lastStepIdx=1\n");

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 150));

    expect(events).toHaveLength(0);
  });

  test("emits done when log reports response completion", async () => {
    writeFileSync(join(tmpDir, "history.jsonl"), JSON.stringify({
      display: "Build support",
      timestamp: Date.now(),
      workspace: "/projects/myapp",
      conversationId: "conv-1",
    }) + "\n");
    const logPath = join(tmpDir, "log", "cli.log");
    writeFileSync(logPath, "");

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 150));
    events.length = 0;

    appendFileSync(logPath, "I0520 text_drip.go:173] Drip stopped: lastStepIdx=1\n");
    (watcher as any).scan();

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("done");
    expect(events[0]!.threadId).toBe("conv-1");
  });
});
