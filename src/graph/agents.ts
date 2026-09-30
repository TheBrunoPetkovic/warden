/**
 * Agent graph source.
 *
 * Read-only discovery of agent sessions and their parent/child links, for the
 * canvas view. Deliberately does not use the SDK: the terminals are the source
 * of truth for *running* processes, but the runtime persists its own history on
 * disk, and that history is what carries the parent links.
 *
 * Honesty note: nothing in any of these stores says "this process is alive
 * right now". No pid, no heartbeat. So `active` below means "touched recently",
 * and the UI labels it that way rather than claiming liveness it cannot see.
 */
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentState = "working" | "needs-input" | "complete" | "idle" | "failed";

export interface AgentNode {
  id: string;
  runtime: "opencode" | "codex" | "claude";
  title: string;
  directory: string;
  parentId?: string;
  created: number;
  updated: number;
  /** Touched within ACTIVE_WINDOW_MS. Not proof of a live process. */
  active: boolean;
  /** A conservative state inferred from the runtime's persisted conversation. */
  state: AgentState;
  cost?: number;
  tokens?: number;
}

export interface AgentEdge {
  from: string;   // parent
  to: string;     // child
}

export interface AgentGraph {
  nodes: AgentNode[];
  edges: AgentEdge[];
  /** Sources that were readable, so the UI can say which runtimes it saw. */
  sources: { runtime: string; ok: boolean; count: number; error?: string }[];
}

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

const opencodeDb = () => join(homedir(), ".local/share/opencode/opencode.db");

const asksForInput = (text: string) =>
  /\?|\b(let me know|need (?:your|a) |could you|would you|which (?:one|option)|please (?:choose|confirm))\b/i.test(text);

/**
 * OpenCode persists a terminal assistant message as `finish: "stop"`. That
 * gives us a useful, read-only completion signal without claiming that an
 * unchanged session is still executing. A final textual question is surfaced
 * as input-needed so it receives the highest visual priority.
 */
function opencodeStates(db: DatabaseSync): Map<string, AgentState> {
  const rows = db.prepare(
    `SELECT m.session_id, m.data AS message,
       (SELECT p.data FROM part p
        WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'text'
        ORDER BY p.time_updated DESC LIMIT 1) AS text
     FROM message m
     JOIN (SELECT session_id, MAX(time_updated) AS latest FROM message GROUP BY session_id) last
       ON last.session_id = m.session_id AND last.latest = m.time_updated`,
  ).all() as { session_id: string; message: string; text?: string }[];
  const out = new Map<string, AgentState>();
  for (const row of rows) {
    try {
      const message = JSON.parse(row.message);
      if (message.role === "user") out.set(row.session_id, "working");
      else if (message.role === "assistant" && (message.error || message.finish === "error" || message.finish === "abort")) out.set(row.session_id, "failed");
      else if (message.role === "assistant" && message.finish === "stop") {
        const text = row.text ? JSON.parse(row.text)?.text : "";
        out.set(row.session_id, typeof text === "string" && asksForInput(text) ? "needs-input" : "complete");
      } else if (message.role === "assistant") out.set(row.session_id, "working");
    } catch {
      // The runtime may be writing a row at the same moment we inspect it.
    }
  }
  return out;
}

export interface SessionActivity {
  kind: "text" | "tool";
  at: number;
  text?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
}

/**
 * OpenCode's SDK does not reliably return messages for a subagent session, but
 * its local store has the same immutable message parts that the TUI renders.
 * This is intentionally read-only and keeps the child as an observation
 * surface: it cannot steer, resume, or otherwise control the agent.
 */
export function readOpenCodeActivity(sessionId: string, limit = 240): SessionActivity[] | null {
  const file = opencodeDb();
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT data, time_updated FROM part WHERE session_id = ? ORDER BY time_created DESC LIMIT ?`,
    ).all(sessionId, limit) as { data: string; time_updated: number }[];
    return rows.reverse().flatMap(row => {
      try {
        const part = JSON.parse(row.data);
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          return [{ kind: "text" as const, at: Number(row.time_updated) || Date.now(), text: part.text }];
        }
        if (part.type === "tool") {
          return [{
            kind: "tool" as const,
            at: Number(row.time_updated) || Date.now(),
            tool: String(part.title ?? part.tool ?? "tool"),
            status: String(part.state?.status ?? "working"),
            input: part.state?.input,
            output: typeof part.state?.output === "string" ? part.state.output : undefined,
          }];
        }
      } catch {
        // A row written while we are reading can be temporarily incomplete.
      }
      return [];
    });
  } finally {
    db.close();
  }
}

async function fromOpencode(): Promise<{ nodes: AgentNode[]; error?: string }> {
  const file = opencodeDb();
  if (!existsSync(file)) return { nodes: [], error: "opencode.db not found" };

  // readOnly matters: opencode is actively writing to this file, and a writable
  // handle from a second process risks lock contention.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const states = opencodeStates(db);
    const rows = db
      .prepare(
        `SELECT id, title, directory, parent_id, time_created, time_updated, cost,
                tokens_input + tokens_output AS tokens
         FROM session ORDER BY time_updated DESC LIMIT 300`,
      )
      .all() as any[];

    const now = Date.now();
    const nodes: AgentNode[] = rows.map(r => ({
      id: r.id,
      runtime: "opencode",
      title: r.title || r.id,
      directory: r.directory || "",
      parentId: r.parent_id || undefined,
      created: Number(r.time_created) || 0,
      updated: Number(r.time_updated) || 0,
      active: now - Number(r.time_updated) < ACTIVE_WINDOW_MS,
      state: states.get(r.id) ?? "idle",
      cost: Number(r.cost) || 0,
      tokens: Number(r.tokens) || 0,
    }));
    return { nodes };
  } finally {
    db.close();
  }
}

async function fromCodex(): Promise<{ nodes: AgentNode[]; error?: string }> {
  const root = join(homedir(), ".codex/sessions");
  if (!existsSync(root)) return { nodes: [], error: "no ~/.codex/sessions" };

  // sessions/<yyyy>/<mm>/<dd>/rollout-<iso>-<uuid>.jsonl
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.name.endsWith(".jsonl")) found.push(full);
    }
  };
  await walk(root, 0);
  if (!found.length) return { nodes: [] };

  // Newest first, and cap the parse: these files grow without bound and the
  // canvas only needs enough to draw a readable graph.
  found.sort();
  const recent = found.slice(-120).reverse();

  const now = Date.now();
  const nodes: AgentNode[] = [];
  for (const file of recent) {
    let meta: any = null;
    try {
      // Only the head matters; the meta record is first and the file can be MBs.
      const handle = await readFile(file, "utf8");
      for (const line of handle.split("\n").slice(0, 40)) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        if (rec.type === "session_meta") { meta = rec.payload; break; }
      }
      if (!meta) continue;
      const st = await stat(file);
      const updated = st.mtimeMs;
      nodes.push({
        id: meta.id ?? meta.session_id,
        runtime: "codex",
        title: shorten(meta.source?.subagent ? `${meta.thread_source} agent` : "codex session", meta.id),
        directory: meta.cwd || "",
        parentId: meta.parent_thread_id && meta.parent_thread_id !== meta.session_id
          ? meta.parent_thread_id
          : undefined,
        created: Date.parse(meta.timestamp || "") || updated,
        updated,
        active: now - updated < ACTIVE_WINDOW_MS,
        state: now - updated < ACTIVE_WINDOW_MS ? "working" : "idle",
      });
    } catch {
      // A rollout being written right now can be a partial line; skip it.
    }
  }
  return { nodes };
}

const shorten = (label: string, id: string) =>
  `${label} ${String(id ?? "").slice(0, 8)}`;

export async function buildAgentGraph(): Promise<AgentGraph> {
  const sources: AgentGraph["sources"] = [];
  const all: AgentNode[] = [];
  const edges: AgentEdge[] = [];
  const seen = new Set<string>();

  for (const [runtime, load] of [
    ["opencode", fromOpencode],
    ["codex", fromCodex],
  ] as const) {
    try {
      const { nodes, error } = await load();
      sources.push({ runtime, ok: !error, count: nodes.length, error });
      for (const n of nodes) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        all.push(n);
      }
    } catch (e: any) {
      sources.push({ runtime, ok: false, count: 0, error: e?.message ?? "failed" });
    }
  }

  // Only link when both ends are present: a dangling edge to a session outside
  // the window would draw a line into nothing.
  const present = new Set(all.map(n => n.id));
  for (const n of all) {
    if (n.parentId && present.has(n.parentId)) edges.push({ from: n.parentId, to: n.id });
  }

  return { nodes: all, edges, sources };
}
