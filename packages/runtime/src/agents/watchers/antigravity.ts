/**
 * Antigravity CLI watcher
 *
 * Antigravity CLI (`agy`) currently stores CLI metadata under
 * ~/.gemini/antigravity-cli. Conversation bodies are protobuf files, so this
 * watcher intentionally avoids parsing them and instead uses the append-only
 * history/log files:
 *
 *   - history.jsonl: user prompts with workspace + conversationId
 *   - log/cli-*.log: lifecycle events such as prompt forwarding, response
 *     completion, and cancellation
 *
 * This is enough to map recent conversations to mux sessions and surface
 * running/done/interrupted status without depending on protobuf internals.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentStatus } from "../../contracts/agent";
import type { AgentWatcher, AgentWatcherContext } from "../../contracts/agent-watcher";

export interface AntigravityHistoryEntry {
  display?: string;
  timestamp?: number;
  workspace?: string;
  conversationId?: string;
}

type LogSignal =
  | { type: "input"; threadName?: string }
  | { type: "conversation"; conversationId: string }
  | { type: "context"; conversationId: string }
  | { type: "status"; status: Extract<AgentStatus, "done" | "interrupted">; conversationId?: string };

interface SessionSnapshot {
  status: AgentStatus;
  projectDir?: string;
  threadName?: string;
  lastActivityMs: number;
}

const POLL_MS = 2000;
const RECENT_MS = 10 * 60 * 1000;
const STUCK_MS = 3 * 60 * 1000;
const THREAD_NAME_MAX = 80;

function normalizeThreadName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, THREAD_NAME_MAX) : undefined;
}

export function parseHistoryEntry(rawLine: string): AntigravityHistoryEntry | null {
  if (!rawLine.trim()) return null;
  try {
    const parsed = JSON.parse(rawLine) as AntigravityHistoryEntry;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.conversationId !== "string" || !parsed.conversationId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseQuotedGoString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

export function parseLogSignal(line: string): LogSignal | null {
  const inputMatch = line.match(/HandleUserInput called with text: "((?:\\.|[^"\\])*)"/);
  if (inputMatch) {
    return { type: "input", threadName: normalizeThreadName(parseQuotedGoString(inputMatch[1]!)) };
  }

  const forwardingMatch = line.match(/(?:Forwarding user message to|Sending user message to) conversation ([A-Za-z0-9_-]+)/);
  if (forwardingMatch) {
    return { type: "conversation", conversationId: forwardingMatch[1]! };
  }

  const contextMatch = line.match(/(?:Created conversation|Starting conversation update stream for) ([A-Za-z0-9_-]+)/);
  if (contextMatch) {
    return { type: "context", conversationId: contextMatch[1]! };
  }

  const cancelMatch = line.match(/Cancelling (?:in-progress response for conversation|conversation) ([A-Za-z0-9_-]+)/);
  if (cancelMatch) {
    return { type: "status", status: "interrupted", conversationId: cancelMatch[1]! };
  }

  if (line.includes("Drip stopped:")) {
    return { type: "status", status: "done" };
  }

  return null;
}

export class AntigravityAgentWatcher implements AgentWatcher {
  readonly name = "antigravity";

  private appDataDir: string;
  private ctx: AgentWatcherContext | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private seeded = false;
  private historyOffset = 0;
  private logOffsets = new Map<string, number>();
  private sessions = new Map<string, SessionSnapshot>();
  private pendingThreadName: string | undefined;
  private latestConversationId: string | undefined;

  constructor() {
    this.appDataDir = process.env.ANTIGRAVITY_CLI_DIR
      ?? join(homedir(), ".gemini", "antigravity-cli");
  }

  start(ctx: AgentWatcherContext): void {
    this.ctx = ctx;
    setTimeout(() => this.scan(), 50);
    this.pollTimer = setInterval(() => this.scan(), POLL_MS);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.ctx = null;
    this.scanning = false;
    this.seeded = false;
    this.historyOffset = 0;
    this.logOffsets.clear();
    this.sessions.clear();
    this.pendingThreadName = undefined;
    this.latestConversationId = undefined;
  }

  private emitStatus(conversationId: string, snapshot: SessionSnapshot): boolean {
    if (!this.ctx || snapshot.status === "idle") return false;

    const session = this.ctx.resolveThreadOwner?.("antigravity", conversationId, snapshot.threadName)?.session
      ?? (snapshot.projectDir ? this.ctx.resolveSession(snapshot.projectDir) : null);
    if (!session) return false;

    this.ctx.emit({
      agent: "antigravity",
      session,
      status: snapshot.status,
      ts: Date.now(),
      threadId: conversationId,
      ...(snapshot.threadName && { threadName: snapshot.threadName }),
    });
    return true;
  }

  private mergeSnapshot(conversationId: string, patch: Partial<SessionSnapshot>): boolean {
    const prev = this.sessions.get(conversationId);
    const next: SessionSnapshot = {
      status: patch.status ?? prev?.status ?? "idle",
      projectDir: patch.projectDir ?? prev?.projectDir,
      threadName: patch.threadName ?? prev?.threadName,
      lastActivityMs: patch.lastActivityMs ?? prev?.lastActivityMs ?? Date.now(),
    };
    this.sessions.set(conversationId, next);
    this.latestConversationId = conversationId;

    return !prev
      || prev.status !== next.status
      || prev.projectDir !== next.projectDir
      || prev.threadName !== next.threadName;
  }

  private applyHistoryText(text: string, changed: Set<string>): void {
    for (const rawLine of text.split("\n")) {
      const entry = parseHistoryEntry(rawLine);
      if (!entry?.conversationId) continue;

      const nextStatus: AgentStatus = "running";
      const didChange = this.mergeSnapshot(entry.conversationId, {
        status: nextStatus,
        projectDir: entry.workspace,
        threadName: normalizeThreadName(entry.display),
        lastActivityMs: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
      });
      if (didChange) changed.add(entry.conversationId);
    }
  }

  private logActivityMs(conversationId: string, refreshActivity: boolean): number {
    if (refreshActivity) return Date.now();
    return this.sessions.get(conversationId)?.lastActivityMs ?? Date.now();
  }

  private applyLogText(text: string, changed: Set<string>, refreshActivity: boolean): void {
    for (const line of text.split("\n")) {
      const signal = parseLogSignal(line);
      if (!signal) continue;

      if (signal.type === "input") {
        this.pendingThreadName = signal.threadName;
        continue;
      }

      if (signal.type === "conversation") {
        const didChange = this.mergeSnapshot(signal.conversationId, {
          status: "running",
          threadName: this.pendingThreadName,
          lastActivityMs: this.logActivityMs(signal.conversationId, refreshActivity),
        });
        this.pendingThreadName = undefined;
        if (didChange) changed.add(signal.conversationId);
        continue;
      }

      if (signal.type === "context") {
        this.latestConversationId = signal.conversationId;
        continue;
      }

      const conversationId = signal.conversationId ?? this.latestConversationId;
      if (!conversationId) continue;

      const didChange = this.mergeSnapshot(conversationId, {
        status: signal.status,
        lastActivityMs: this.logActivityMs(conversationId, refreshActivity),
      });
      if (didChange) changed.add(conversationId);
    }
  }

  private readIncremental(filePath: string, prevOffset: number): { text: string; offset: number } | null {
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return null;
    }
    if (size === prevOffset) return { text: "", offset: size };

    try {
      const text = readFileSync(filePath, "utf-8");
      if (size < prevOffset) return { text, offset: size };
      return { text: text.slice(prevOffset), offset: size };
    } catch {
      return null;
    }
  }

  private collectLogFiles(): string[] {
    const logDir = join(this.appDataDir, "log");
    let names: string[];
    try {
      names = readdirSync(logDir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(".log"))
      .map((name) => join(logDir, name))
      .sort();
  }

  private markStale(changed: Set<string>): void {
    const now = Date.now();
    for (const [conversationId, snapshot] of this.sessions) {
      if (snapshot.status !== "running") continue;
      if (now - snapshot.lastActivityMs < STUCK_MS) continue;
      snapshot.status = "stale";
      changed.add(conversationId);
    }
  }

  private scan(): void {
    if (!this.ctx || this.scanning || !existsSync(this.appDataDir)) return;
    this.scanning = true;

    try {
      const changed = new Set<string>();

      const historyPath = join(this.appDataDir, "history.jsonl");
      const history = this.readIncremental(historyPath, this.historyOffset);
      if (history) {
        this.historyOffset = history.offset;
        this.applyHistoryText(history.text, changed);
      }

      for (const logFile of this.collectLogFiles()) {
        const prevOffset = this.logOffsets.get(logFile) ?? 0;
        const result = this.readIncremental(logFile, prevOffset);
        if (!result) continue;
        this.logOffsets.set(logFile, result.offset);
        this.applyLogText(result.text, changed, this.seeded);
      }

      this.markStale(changed);

      if (!this.seeded) {
        this.seeded = true;
        const cutoff = Date.now() - RECENT_MS;
        for (const [conversationId, snapshot] of this.sessions) {
          if (snapshot.status === "idle" || snapshot.lastActivityMs < cutoff) continue;
          this.emitStatus(conversationId, snapshot);
        }
        return;
      }

      for (const conversationId of changed) {
        const snapshot = this.sessions.get(conversationId);
        if (!snapshot) continue;
        this.emitStatus(conversationId, snapshot);
      }
    } finally {
      this.scanning = false;
    }
  }
}
