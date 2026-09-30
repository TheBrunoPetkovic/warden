/**
 * Live agent detection.
 *
 * The disk records (opencode.db, codex rollout files) can tell you what an agent
 * did, but not whether it is running right now. This module answers that
 * question from the process table, which is the only place liveness actually
 * exists.
 *
 * Scope is deliberate: an agent counts as "in this workspace" when its cwd is
 * the workspace directory (or below it), and it is reported as running in a
 * Warden pane when its process subtree descends from one of our PTY shells.
 * A detached opencode elsewhere on the machine is a different thing and is not
 * silently folded in.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface LiveAgent {
  pid: number;
  runtime: "opencode" | "codex" | "claude";
  cwd: string;
  /** Session id when the process states it, otherwise matched by time+dir. */
  sessionId?: string;
  matched: "explicit" | "inferred" | "none";
  startedAt: number;
  /** Terminal id when the process runs inside one of Warden's panes. */
  terminalId?: string;
  title?: string;
  tokens?: number;
  cost?: number;
  parentId?: string;
}

interface Proc {
  pid: number;
  ppid: number;
  argv: string;
  startedAt: number;
}

const AGENT_BINARIES = new Set(["opencode", "codex", "claude"]);

/**
 * Sub-commands that are a server or a one-shot, not an interactive agent
 * session someone is driving. Matched on the argument list, not the binary
 * name: `opencode serve` and Codex's bundled app-server both share the name of
 * the agent binary.
 */
const NOT_AN_AGENT = [/ serve\b/, /\bapp-server\b/, /\b--version\b/, /\b--help\b/];

/**
 * `ps -o etime` is [[dd-]hh:]mm:ss, which is locale independent -- unlike
 * lstart, which is not, and which silently breaks under a non-English locale.
 * The field count is the only reliable signal for which parts are present: a
 * young process prints "00:26" (mm:ss), not "00:00:26".
 */
function parseEtime(s: string, now: number): number {
  const t = s.trim();
  if (!t) return now;
  let days = 0;
  let clock = t;
  if (clock.includes("-")) {
    const [d, rest] = clock.split("-");
    days = Number(d) || 0;
    clock = rest;
  }
  const parts = clock.split(":").map(Number);
  let seconds = 0;
  if (parts.length === 1) seconds = parts[0];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else seconds = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  if (!Number.isFinite(seconds)) return now;
  return now - (days * 86400 + seconds) * 1000;
}

async function listProcesses(now: number): Promise<Map<number, Proc>> {
  const { stdout } = await run("ps", ["-Ao", "pid=,ppid=,etime=,command="], { maxBuffer: 8 << 20 });
  const procs = new Map<number, Proc>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // command is the remainder and may contain spaces, so split off a fixed head.
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, etime, argv] = m;
    procs.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      argv,
      startedAt: parseEtime(etime, now),
    });
  }
  return procs;
}

/** Batch lsof: one process for all pids, not one per pid. ~20ms for a full scan. */
async function cwdFor(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, number>();
  for (let i = 0; i < pids.length; i += 200) {
    const chunk = pids.slice(i, i + 200);
    let stdout = "";
    try {
      ({ stdout } = await run("lsof", ["-a", "-p", chunk.join(","), "-d", "cwd", "-Fn"], {
        maxBuffer: 4 << 20,
      }));
    } catch {
      // lsof exits non-zero when a pid vanishes mid-scan; partial output is fine.
    }
    let pid: number | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid != null) out.set(pid, line.slice(1));
    }
  }
  const result = new Map<number, string>();
  for (const [pid] of out) result.set(pid, out.get(pid)!);
  return result;
}

function ancestors(pid: number, procs: Map<number, Proc>): number[] {
  const chain: number[] = [];
  let cur = procs.get(pid)?.ppid;
  let guard = 0;
  while (cur && cur > 1 && guard++ < 64) {
    chain.push(cur);
    cur = procs.get(cur)?.ppid;
  }
  return chain;
}

export interface DetectOptions {
  workspacePath: string;
  /** pid -> terminal id, from the PTY pool. */
  shellPids: Map<number, string>;
  /** Session records to enrich with, from buildAgentGraph(). */
  sessions: { id: string; runtime: string; directory: string; created: number; title: string; tokens?: number; cost?: number; parentId?: string }[];
}

export async function detectLiveAgents(opts: DetectOptions): Promise<LiveAgent[]> {
  const now = Date.now();
  const procs = await listProcesses(now);
  const root = opts.workspacePath.replace(/\/+$/, "");

  const candidates: Proc[] = [];
  for (const p of procs.values()) {
    if (p.pid === process.pid) continue;
    const argv = p.argv.trim();
    if (!argv) continue;
    const bin = argv.split(/\s+/)[0].split("/").pop() ?? "";
    if (!AGENT_BINARIES.has(bin)) continue;
    // `opencode serve` is the SDK server, not an agent someone is driving.
    if (NOT_AN_AGENT.some(re => re.test(argv))) continue;
    candidates.push(p);
  }
  if (!candidates.length) return [];

  const cwds = await cwdFor(candidates.map(c => c.pid));

  const found: LiveAgent[] = [];
  for (const c of candidates) {
    const cwd = cwds.get(c.pid) ?? "";
    const inWorkspace = cwd === root || cwd.startsWith(root + "/");
    if (!inWorkspace) continue;

    const bin = c.argv.trim().split(/\s+/)[0].split("/").pop()!;
    const agent: LiveAgent = {
      pid: c.pid,
      runtime: bin as LiveAgent["runtime"],
      cwd,
      startedAt: c.startedAt,
      matched: "none",
    };

    const chain = ancestors(c.pid, procs);
    for (const [pid, tid] of opts.shellPids) {
      if (pid === c.pid || chain.includes(pid)) {
        agent.terminalId = tid;
        break;
      }
    }

    // opencode --session <id> names its session outright; a bare `opencode` TUI
    // does not, so it gets matched by directory and start time.
    const explicit = c.argv.match(/--session[= ]\s*(\S+)/)?.[1];
    const sameDir = opts.sessions.filter(s => s.directory.replace(/\/+$/, "") === root);

    if (explicit) {
      const s = sameDir.find(x => x.id === explicit);
      if (s) {
        agent.sessionId = s.id;
        agent.matched = "explicit";
        agent.title = s.title;
        agent.tokens = s.tokens;
        agent.cost = s.cost;
        agent.parentId = s.parentId;
      }
    } else {
      // A TUI creates its session row a moment after the process starts. Pick
      // the nearest unused row, and only when the window is tight enough that
      // the pairing is not a guess dressed up as a fact.
      const CANDIDATE_WINDOW = 90_000;
      const best = sameDir
        .filter(s => s.created - c.startedAt > -10_000 && s.created - c.startedAt < CANDIDATE_WINDOW)
        .sort((a, b) => Math.abs(a.created - c.startedAt) - Math.abs(b.created - c.startedAt))[0];
      if (best) {
        agent.sessionId = best.id;
        agent.matched = "inferred";
        agent.title = best.title;
        agent.tokens = best.tokens;
        agent.cost = best.cost;
        agent.parentId = best.parentId;
      }
    }
    found.push(agent);
  }
  return found.sort((a, b) => a.startedAt - b.startedAt);
}
