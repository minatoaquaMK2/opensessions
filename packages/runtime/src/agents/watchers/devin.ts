/**
 * Devin agent watcher
 *
 * Polls the Devin CLI SQLite database (~/.local/share/devin/cli/sessions.db)
 * to determine agent status and emits events mapped to mux sessions
 * via the `working_directory` field on each Devin session row.
 *
 * All queries use bun:sqlite in readonly mode.
 *
 * ## Devin CLI SQLite Schema (observed v2026.4.29-0)
 *
 * ### Tables used
 *   - `sessions` — one row per Devin CLI session
 *       - `id` (TEXT PRIMARY KEY) — slug like "jelly-zucchini" or UUID
 *       - `working_directory`, `title`
 *       - `main_chain_id` — INTEGER pointing at the head node of the active chain
 *       - `last_activity_at` (INTEGER, **seconds since epoch**)
 *       - `hidden` — INTEGER, 1 means user hid the session
 *       - other fields: `backend_type`, `model`, `agent_mode`, `created_at`, ...
 *   - `message_nodes` — tree-structured chat history
 *       - `(session_id, node_id)` UNIQUE, with `parent_node_id` for the tree
 *       - `chat_message` (JSON)
 *
 * Timestamps in this database are in **seconds**, unlike most other watchers
 * which use millisecond timestamps. We always convert to ms when comparing
 * against `Date.now()`.
 *
 * ### chat_message JSON shape
 *   ```
 *   {
 *     role: "user" | "assistant" | "tool" | "system",
 *     content: string | Array<{ type, text }>,
 *     tool_calls?: [...],            // only on assistant messages
 *     metadata?: {
 *       finish_reason?: "stop" | "tool_calls" | "error" | "length" | null,
 *       extensions?: { ... },
 *       telemetry?: { source, operation }
 *     }
 *   }
 *   ```
 *
 * ## Status Detection
 *
 * The watcher fetches the head node of each session via `main_chain_id` and
 * derives status from the role + finish_reason combination:
 *
 *   | head node                                      | status        |
 *   | ---------------------------------------------- | ------------- |
 *   | role=user                                      | running       |
 *   | role=tool                                      | running       |
 *   | role=assistant + finish_reason=tool_calls      | running       |
 *   | role=assistant + finish_reason=stop            | done          |
 *   | role=assistant + finish_reason=error           | error         |
 *   | role=assistant + finish_reason=length          | done          |
 *   | role=assistant (no finish_reason yet)          | running       |
 *   | role=system + content="[Response interrupted]" | interrupted   |
 *   | role=system (system prompt)                    | idle          |
 *
 * ### Lifecycle (observed)
 *   1. `devin` boots → row in `sessions`, system prompt nodes appear
 *   2. User submits prompt → `role=user` node appended
 *   3. Streaming response → `role=assistant` nodes (finish_reason=null while streaming)
 *   4. Tool call → `role=assistant` with finish_reason=tool_calls + `tool_calls`
 *      array; followed by one or more `role=tool` result nodes
 *   5. Final answer → `role=assistant` with finish_reason=stop
 *   6. Interrupt (Ctrl+C / Esc) → `role=system` node with content
 *      `"[Response interrupted by user]"`. Usually followed by another user
 *      prompt; when the chain ends here, the session is "interrupted".
 *
 * ### Stuck detection
 *   When status is "running" but `last_activity_at` hasn't advanced for
 *   STUCK_MS we promote to "stale" — the Devin process probably died.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentStatus } from "../../contracts/agent";
import type { AgentWatcher, AgentWatcherContext } from "../../contracts/agent-watcher";

// --- Types ---

interface SessionRow {
  id: string;
  title: string | null;
  working_directory: string;
  main_chain_id: number | null;
  last_activity_at: number;
}

interface NodeRow {
  chat_message: string;
}

interface ChatMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  tool_calls?: unknown[];
  metadata?: {
    finish_reason?: string | null;
    extensions?: Record<string, unknown>;
  };
}

const POLL_MS = 3000;
/** Sessions older than this (in seconds) are skipped during scans. */
const STALE_SEC = 5 * 60;
/** How long a "running" session can go without activity before we assume the process died (ms). */
const STUCK_MS = 15_000;

const INTERRUPT_PATTERNS = [
  "[Response interrupted by user",
  "[Response interrupted",
];

// --- Status detection ---

/**
 * Determine the agent status from the head chat message of a session.
 *
 * Exported for independent testing.
 */
export function determineStatus(msg: ChatMessage | null): AgentStatus {
  if (!msg?.role) return "idle";

  if (msg.role === "user") return "running";
  if (msg.role === "tool") return "running";

  if (msg.role === "system") {
    const text = extractText(msg.content);
    if (text && INTERRUPT_PATTERNS.some((p) => text.startsWith(p))) return "interrupted";
    // Other system messages are system prompts / metadata — not user-visible activity
    return "idle";
  }

  if (msg.role === "assistant") {
    const text = extractText(msg.content);
    if (text && INTERRUPT_PATTERNS.some((p) => text.startsWith(p))) return "interrupted";

    const finish = msg.metadata?.finish_reason;
    if (finish === "stop") return "done";
    if (finish === "tool_calls") return "running";
    if (finish === "error") return "error";
    if (finish === "length") return "done";
    // No finish_reason yet → streaming
    return "running";
  }

  return "idle";
}

function extractText(content: ChatMessage["content"]): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item?.type === "text" && typeof item.text === "string") return item.text;
    }
  }
  return undefined;
}

// --- Session snapshot ---

interface SessionSnapshot {
  status: AgentStatus;
  title: string | null;
  workingDirectory: string;
  mainChainId: number | null;
  /** last_activity_at in **seconds** as observed in the DB. */
  lastActivitySec: number;
  /** ms timestamp when we last observed last_activity_at advance. For stuck detection. */
  lastGrowthAt: number;
}

// --- Watcher implementation ---

export class DevinAgentWatcher implements AgentWatcher {
  readonly name = "devin";

  private sessions = new Map<string, SessionSnapshot>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ctx: AgentWatcherContext | null = null;
  private db: any = null;
  private dbPath: string;
  private polling = false;
  private seeded = false;

  constructor() {
    this.dbPath = process.env.DEVIN_CLI_DB_PATH
      ?? join(homedir(), ".local", "share", "devin", "cli", "sessions.db");
  }

  start(ctx: AgentWatcherContext): void {
    this.ctx = ctx;
    setTimeout(() => this.poll(), 50);
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    try { this.db?.close(); } catch {}
    this.db = null;
    this.ctx = null;
  }

  /** Emit a status change event if we have a valid session mapping */
  private emitStatus(sessionId: string, snapshot: SessionSnapshot): boolean {
    if (!this.ctx || !snapshot.workingDirectory || snapshot.status === "idle") return false;

    const session = this.ctx.resolveThreadOwner?.("devin", sessionId, snapshot.title ?? undefined)?.session
      ?? this.ctx.resolveSession(snapshot.workingDirectory);
    if (!session) return false;

    this.ctx.emit({
      agent: "devin",
      session,
      status: snapshot.status,
      ts: Date.now(),
      threadId: sessionId,
      ...(snapshot.title && { threadName: snapshot.title }),
    });
    return true;
  }

  private openDb(): boolean {
    if (this.db) return true;
    if (!existsSync(this.dbPath)) return false;
    try {
      const { Database } = require("bun:sqlite");
      this.db = new Database(this.dbPath, { readonly: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch the head node and derive its status */
  private readSessionStatus(sessionId: string, mainChainId: number | null): AgentStatus {
    if (mainChainId === null || mainChainId === undefined) return "idle";

    let row: NodeRow | null = null;
    try {
      row = this.db.query(
        `SELECT chat_message FROM message_nodes WHERE session_id = ? AND node_id = ?`,
      ).get(sessionId, mainChainId);
    } catch {
      return "idle";
    }
    if (!row) return "idle";

    let msg: ChatMessage | null = null;
    try { msg = JSON.parse(row.chat_message); } catch {}
    return determineStatus(msg);
  }

  private poll(): void {
    if (!this.ctx || this.polling) return;
    this.polling = true;

    try {
      if (!this.openDb()) return;

      let rows: SessionRow[];
      const staleThresholdSec = Math.floor(Date.now() / 1000) - STALE_SEC;
      try {
        rows = this.db.query(
          `SELECT id, title, working_directory, main_chain_id, last_activity_at
             FROM sessions
            WHERE hidden = 0
              AND last_activity_at > ?
            ORDER BY last_activity_at DESC`,
        ).all(staleThresholdSec);
      } catch {
        try { this.db.close(); } catch {}
        this.db = null;
        return;
      }

      const now = Date.now();

      // --- Seed: record current state, then emit non-idle sessions ---
      if (!this.seeded) {
        for (const row of rows) {
          const status = this.readSessionStatus(row.id, row.main_chain_id);
          this.sessions.set(row.id, {
            status,
            title: row.title,
            workingDirectory: row.working_directory,
            mainChainId: row.main_chain_id,
            lastActivitySec: row.last_activity_at,
            lastGrowthAt: now,
          });
        }
        this.seeded = true;

        for (const [sessionId, snapshot] of this.sessions) {
          this.emitStatus(sessionId, snapshot);
        }
        return;
      }

      // --- Incremental: detect changes via last_activity_at ---
      for (const row of rows) {
        const prev = this.sessions.get(row.id);

        if (prev && prev.lastActivitySec === row.last_activity_at) {
          // Session unchanged — check for stuck detection
          if (prev.status === "running" && now - prev.lastGrowthAt >= STUCK_MS) {
            prev.status = "stale";
            this.emitStatus(row.id, prev);
          }
          continue;
        }

        // Session changed — read current status
        const status = this.readSessionStatus(row.id, row.main_chain_id);
        const prevStatus = prev?.status;
        const prevTitle = prev?.title;

        const snapshot: SessionSnapshot = {
          status,
          title: row.title,
          workingDirectory: row.working_directory,
          mainChainId: row.main_chain_id,
          lastActivitySec: row.last_activity_at,
          lastGrowthAt: now,
        };
        this.sessions.set(row.id, snapshot);

        // Emit when:
        //   - existing session changed status or title
        //   - we just discovered a brand-new post-seed session in a non-idle state
        // (an idle/system-prompt-only session is not user-visible activity)
        const isNewActivity = !prev && status !== "idle";
        const isStateChange = prev && (status !== prevStatus || prevTitle !== row.title);
        if (isNewActivity || isStateChange) {
          this.emitStatus(row.id, snapshot);
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
