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

async function fromOpencode(): Promise<{ nodes: AgentNode[]; error?: string }> {
  const file = opencodeDb();
  if (!existsSync(file)) return { nodes: [], error: "opencode.db not found" };

  // readOnly matters: opencode is actively writing to this file, and a writable
  // handle from a second process risks lock contention.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
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
