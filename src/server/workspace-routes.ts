/**
 * Workspace + terminal REST routes.
 *
 * Split from the main server because this is the Herd-spaces surface: it owns
 * lifecycle (create, delete, spawn shells) and is independent of which agent
 * runtime happens to be plugged in.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { WorkspaceStore, HttpError, DEFAULT_TERM } from "../workspaces/store.ts";
import type { PtyPool } from "../pty/pool.ts";

const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

const readBody = (req: IncomingMessage): Promise<any> =>
  new Promise(resolve_ => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      try {
        resolve_(raw ? JSON.parse(raw) : {});
      } catch {
        resolve_({});
      }
    });
  });

export async function handleWorkspaceRoutes(
  path: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkspaceStore,
  pool: PtyPool,
): Promise<boolean> {
  if (!path.startsWith("/api/workspaces") && !path.startsWith("/api/terminals")) return false;

  try {
    // --- workspaces -------------------------------------------------
    if (path === "/api/workspaces" && method === "GET") {
      const all = await store.list();
      // `missing` is computed on read, never persisted: it describes the disk
      // right now, not what was true when the record was written.
      return json(res, 200, all.map(w => ({
        ...w,
        missing: store.missing(w),
        terminals: pool.forWorkspace(w.id).length,
      }))), true;
    }

    if (path === "/api/workspaces" && method === "POST") {
      const { name, path: dir } = await readBody(req);
      const ws = await store.create(name, dir);
      return json(res, 201, ws), true;
    }

    // Agent-first UI entry point. The raw-shell route remains for internal
    // terminal lifecycle compatibility, but this endpoint only starts the
    // supported interactive runtime and never accepts arbitrary commands.
    const newAgent = path.match(/^\/api\/workspaces\/([^/]+)\/agents$/);
    if (newAgent && method === "POST") {
      const workspaceId = decodeURIComponent(newAgent[1]);
      const ws = await store.get(workspaceId);
      if (!ws) return json(res, 404, { error: "workspace not found" }), true;
      if (store.missing(ws)) return json(res, 409, { error: `workspace directory is gone: ${ws.path}` }), true;
      const term = await pool.spawn({
        workspaceId,
        cwd: ws.path,
        shell: DEFAULT_TERM,
        cols: 100,
        rows: 28,
      });
      // A shell's input buffer survives its profile startup, so this does not
      // depend on a browser websocket reaching the pane first.
      pool.write(term.id, "opencode\r");
      return json(res, 201, { id: term.id, workspaceId, path: ws.path, runtime: "opencode", pid: term.pty.pid }), true;
    }

    const one = path.match(/^\/api\/workspaces\/([^/]+)$/);
    if (one && method === "GET") {
      const ws = await store.get(decodeURIComponent(one[1]));
      if (!ws) return json(res, 404, { error: "workspace not found" }), true;
      return json(res, 200, { ...ws, terminals: pool.forWorkspace(ws.id) }), true;
    }

    if (one && method === "PATCH") {
      const patch = await readBody(req);
      const ws = await store.update(decodeURIComponent(one[1]), patch);
      return json(res, 200, ws), true;
    }

    if (one && method === "DELETE") {
      const id = decodeURIComponent(one[1]);
      // Never leave an orphaned shell holding a deleted directory open.
      const killed = pool.killWorkspace(id);
      const r = await store.remove(id, { deleteFiles: true });
      return json(res, 200, { ...r, terminalsKilled: killed }), true;
    }

    // --- terminals --------------------------------------------------
    if (path === "/api/terminals" && method === "GET") return json(res, 200, pool.list()), true;

    if (path === "/api/terminals" && method === "POST") {
      const { workspaceId, cols, rows } = await readBody(req);
      const ws = await store.get(workspaceId);
      if (!ws) return json(res, 404, { error: "workspace not found" }), true;
      // Guarded here rather than left to node-pty: a record whose directory was
      // removed out of band would otherwise fail as a 500 with a stack trace out
      // of the pool, which reads like a PTY bug instead of a stale record.
      if (store.missing(ws)) {
        return json(res, 409, { error: `workspace directory is gone: ${ws.path}` }), true;
      }
      const term = await pool.spawn({
        workspaceId,
        cwd: ws.path,
        shell: DEFAULT_TERM,
        cols,
        rows,
      });
      return json(res, 201, { id: term.id, workspaceId, path: ws.path, shell: DEFAULT_TERM }), true;
    }

    const term = path.match(/^\/api\/terminals\/([^/]+)$/);
    if (term && method === "DELETE") {
      const ok = pool.kill(decodeURIComponent(term[1]));
      return json(res, ok ? 200 : 404, { ok }), true;
    }

    if (term && method === "POST") {
      const t = pool.get(decodeURIComponent(term[1]));
      if (!t) return json(res, 404, { error: "terminal not found" }), true;
      return json(res, 200, { id: t.id, alive: t.alive, exitCode: t.exitCode }), true;
    }

    return json(res, 404, { error: "not found" }), true;
  } catch (e: any) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message }), true;
    console.error("[workspaces]", path, e);
    return json(res, 500, { error: e?.message ?? "internal error" }), true;
  }
}
