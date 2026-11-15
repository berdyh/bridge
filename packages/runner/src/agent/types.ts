import type { EventEmitter } from "node:events";

import type { AgentAvailability } from "@berdyh/bridge-protocol";
import type { ProcessCleanupResult } from "../acp/cleanup.js";

export type AgentId = "claude-code" | "codex-cli";

export const AGENT_IDS: readonly AgentId[] = ["codex-cli", "claude-code"];

/**
 * Ids used on the wire (bridge-protocol `AgentAvailability.id`: "claude",
 * "codex"). Internal ids keep the longer names; this is the one mapping.
 */
export const PROTOCOL_AGENT_IDS: Record<AgentId, string> = {
  "claude-code": "claude",
  "codex-cli": "codex",
};

export const AGENT_BIN_NAMES: Record<AgentId, string> = {
  "claude-code": "claude",
  "codex-cli": "codex",
};

/** The slice of a child process the agent module uses. */
export interface ChildLike {
  stdout: Pick<EventEmitter, "on"> | null;
  stderr: Pick<EventEmitter, "on"> | null;
  stdin: { write(data: string): unknown; end(): unknown; on(event: "error", cb: (e: Error) => void): unknown } | null;
  on(event: "error", cb: (e: Error) => void): unknown;
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
  /** Full descendant cleanup evidence; direct child exit alone is insufficient. */
  cleanup?(): Promise<ProcessCleanupResult>;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; requireCleanup?: boolean },
) => ChildLike;

/** Everything environmental the agent module needs, so tests never touch the real machine. */
export interface AgentEnvironment {
  spawn: SpawnFn;
  /** The parent environment to filter (instead of process.env). */
  env: Record<string, string | undefined>;
  homedir: string;
  /** Parent of the per-run throwaway dirs. */
  tmpBase: string;
}

export interface AgentTask {
  /** Caller's id; generated when omitted. */
  id?: string;
  prompt: string;
  systemPrompt?: string;
  /** When set the agent is asked for JSON satisfying this schema. */
  schema?: unknown;
  /** Restrict to one agent (skips failover). */
  agent?: AgentId;
}

export type FailureReason =
  | "not_installed"
  | "auth_permanent"
  | "rate_limit"
  | "overloaded"
  | "timeout"
  | "format"
  | "cancelled"
  | "unknown";

export interface AgentAttempt {
  agent: AgentId;
  reason: FailureReason;
  message: string;
}

export type TaskResult =
  | { ok: true; agent: AgentId; output: string; attempts: AgentAttempt[] }
  | { ok: false; reason: FailureReason; message: string; attempts: AgentAttempt[] };

export interface TaskHandle {
  id: string;
  result: Promise<TaskResult>;
}

export interface AgentStatus {
  agent: AgentId;
  installed: boolean;
  authenticated: boolean;
  command?: string;
  source?: "override" | "npx-cache" | "path";
  /** Set when probing failed (e.g. tmp dir unwritable); `authenticated` is then false. */
  error?: string;
}

export interface RunnerStatus {
  agents: AgentStatus[];
  running: string[];
}

/** Heartbeat `agents[]` for a status snapshot. Available = installed and signed in. */
export function toHeartbeatAgents(status: RunnerStatus): AgentAvailability[] {
  return status.agents.map((a) => ({
    id: PROTOCOL_AGENT_IDS[a.agent],
    available: a.installed && a.authenticated,
  }));
}
