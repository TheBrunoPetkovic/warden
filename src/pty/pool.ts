/**
 * PTY pool -- one real shell per open terminal, multiplexed to the browser.
 *
 * Model: spawn is expensive and shell state (env, cd, history) is the whole
 * point, so a terminal keeps its process alive while the browser disconnects.
 * Reconnect replays a scrollback buffer rather than a fresh shell.
 */
import { existsSync } from "node:fs";
import type { IPty } from "node-pty";

let ptyModule: typeof import("node-pty") | null = null;

/**
 * npm's allow-scripts guard skips node-pty's postinstall, leaving spawn-helper
 * without its execute bit, which surfaces as a bare "posix_spawnp failed".
 * Restoring the bit here turns a cryptic crash into a working terminal.
 */
async function loadPty() {
  if (ptyModule) return ptyModule;
  const mod = await import("node-pty");
  const helper = (mod as any).native?.dir;
  if (helper) {
    const { chmod } = await import("node:fs/promises");
    const path = helper.endsWith("spawn-helper")
      ? helper
      : `${helper}/spawn-helper`;
    if (existsSync(path)) {
      try {
        await chmod(path, 0o755);
      } catch {
        /* already correct, or read-only install -- spawn will report it */
      }
    }
  }
  ptyModule = mod;
  return mod;
}

export interface Terminal {
  id: string;
  workspaceId: string;
  pty: IPty;
  scrollback: string;
  alive: boolean;
  exitCode?: number;
  cols: number;
  rows: number;
}

// Keep enough raw output to restore a long-lived ordinary shell after a browser
// reload. Full-screen TUIs such as OpenCode own their in-app scroll state, but
// normal terminal programs should not silently lose history after ~2,000 lines.
const SCROLLBACK_LIMIT = 2_000_000;

export class PtyPool {
  private terms = new Map<string, Terminal>();
  private seq = 0;

  async spawn(opts: {
    workspaceId: string;
    cwd: string;
    shell: string;
    /** Explicit argv for a purpose-built pane (for example an agent runtime). */
    args?: string[];
    cols?: number;
    rows?: number;
  }): Promise<Terminal> {
    if (!existsSync(opts.shell)) throw new Error(`shell not found: ${opts.shell}`);
    if (!existsSync(opts.cwd)) throw new Error(`cwd not found: ${opts.cwd}`);

    const pty = await loadPty();
    const cols = Math.max(20, opts.cols ?? 80);
    const rows = Math.max(5, opts.rows ?? 24);

    const proc = pty.spawn(opts.shell, opts.args ?? ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        // Marks the shell so profiles and prompts can adapt to a Warden pane.
        WARDEN_WORKSPACE: opts.workspaceId,
      },
    });

    const term: Terminal = {
      id: `t${++this.seq}`,
      workspaceId: opts.workspaceId,
      pty: proc,
      scrollback: "",
      alive: true,
      cols,
      rows,
    };

    proc.onData(d => {
      term.scrollback += d;
      if (term.scrollback.length > SCROLLBACK_LIMIT) {
        term.scrollback = term.scrollback.slice(-SCROLLBACK_LIMIT);
      }
      this.onData?.(term, d);
    });
    proc.onExit(({ exitCode }) => {
      term.alive = false;
      term.exitCode = exitCode;
      this.onExit?.(term, exitCode);
    });

    this.terms.set(term.id, term);
    return term;
  }

  /** Set by the server to fan out to connected browsers. */
  onData?: (term: Terminal, data: string) => void;
  onExit?: (term: Terminal, code: number) => void;

  get(id: string) {
    return this.terms.get(id) ?? null;
  }

  forWorkspace(workspaceId: string) {
    return [...this.terms.values()].filter(t => t.workspaceId === workspaceId);
  }

  list() {
    return [...this.terms.values()].map(t => ({
      id: t.id,
      workspaceId: t.workspaceId,
      alive: t.alive,
      exitCode: t.exitCode,
      // The shell pid is the root of this terminal's process subtree. The agent
      // graph uses it to tell an agent running in a Warden pane apart from an
      // unrelated agent that merely happens to sit in the same directory.
      pid: t.pty.pid,
    }));
  }

  write(id: string, data: string) {
    const t = this.terms.get(id);
    if (!t) throw new Error("terminal not found");
    if (!t.alive) throw new Error("terminal has exited");
    t.pty.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const t = this.terms.get(id);
    if (!t || !t.alive) return;
    t.cols = Math.max(20, Math.floor(cols));
    t.rows = Math.max(5, Math.floor(rows));
    t.pty.resize(t.cols, t.rows);
  }

  kill(id: string) {
    const t = this.terms.get(id);
    if (!t) return false;
    try {
      t.pty.kill();
    } catch {
      /* already gone */
    }
    t.alive = false;
    this.terms.delete(id);
    return true;
  }

  killWorkspace(workspaceId: string) {
    const victims = this.forWorkspace(workspaceId);
    for (const t of victims) this.kill(t.id);
    return victims.length;
  }

  killAll() {
    for (const t of this.terms.values()) this.kill(t.id);
  }
}
