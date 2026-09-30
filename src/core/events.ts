/**
 * The one event model every runtime maps into.
 *
 * Adapter-specific shapes stop at the adapter boundary. Nothing above this
 * file knows that opencode calls it `permission.asked` or that Codex calls it
 * `execCommandApproval`. Adding a runtime means writing a mapper, not editing
 * the UI.
 */

export type Runtime = "opencode" | "codex";

export type SessionStatus = "idle" | "busy" | "retry";

export interface SessionInfo {
  runtime: Runtime;
  id: string;
  title: string;
  directory: string;
  status: SessionStatus;
  cost: number;
  tokens: number;
}

export interface PermissionRequest {
  permissionId: string;
  sessionId: string;
  /** "bash" | "edit" | "webfetch" | ... */
  kind: string;
  /** Human-readable subject: the command, the file path. */
  summary: string;
  /** Pre-generated pattern for "always allow this". */
  alwaysPattern?: string;
  /** Raw runtime payload, kept for a detail view. */
  raw?: unknown;
}

export type NormalizedEvent =
  | { kind: "session.created"; at: number; runtime: Runtime; session: SessionInfo }
  | { kind: "session.status"; at: number; runtime: Runtime; sessionId: string; status: SessionStatus; detail?: string }
  | { kind: "session.idle"; at: number; runtime: Runtime; sessionId: string }
  | { kind: "text.delta"; at: number; runtime: Runtime; sessionId: string; messageId: string; partId: string; text: string }
  | { kind: "text.done"; at: number; runtime: Runtime; sessionId: string; messageId: string; partId: string; text: string }
  | { kind: "tool.started"; at: number; runtime: Runtime; sessionId: string; callId: string; tool: string; input?: unknown }
  | { kind: "tool.completed"; at: number; runtime: Runtime; sessionId: string; callId: string; tool: string; status: string; output?: string }
  | { kind: "permission.requested"; at: number; runtime: Runtime; request: PermissionRequest }
  | { kind: "permission.resolved"; at: number; runtime: Runtime; sessionId: string; permissionId: string; response: string }
  | { kind: "diff"; at: number; runtime: Runtime; sessionId: string; diff: unknown }
  | { kind: "runtime.log"; at: number; runtime: Runtime; level: "info" | "warn" | "error"; message: string };

export const now = () => Date.now();

/**
 * Fan-out bus. Adapters publish, the HTTP layer subscribes, the UI never
 * talks to an adapter directly.
 */
export class EventBus {
  #subs = new Set<(e: NormalizedEvent) => void>();
  #ring: NormalizedEvent[] = [];
  readonly #limit: number;

  constructor(limit = 2000) {
    this.#limit = limit;
  }

  publish(e: NormalizedEvent) {
    this.#ring.push(e);
    if (this.#ring.length > this.#limit) this.#ring.splice(0, this.#ring.length - this.#limit);
    for (const fn of this.#subs) {
      try {
        fn(e);
      } catch {
        // A broken subscriber must not stall the runtime.
      }
    }
  }

  subscribe(fn: (e: NormalizedEvent) => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  /** Replay buffer so a browser that connects late still renders history. */
  history(): NormalizedEvent[] {
    return this.#ring.slice();
  }
}
