import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { EventBus, NormalizedEvent, Runtime } from "./core/events.ts";
import { WorkspaceStore } from "./workspaces/store.ts";
import { PtyPool } from "./pty/pool.ts";
import { handleWorkspaceRoutes } from "./server/workspace-routes.ts";
import { attachTerminalSocket } from "./server/terminal-ws.ts";
import { buildAgentGraph } from "./graph/agents.ts";
import { layout } from "./graph/layout.ts";
import { detectLiveAgents } from "./graph/live.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI = join(__dirname, "ui");
const ROOT = join(__dirname, "..");

/**
 * The UI is edited constantly during development and served without a build
 * step, so a cached copy means silently running yesterday's CSS. An explicit
 * no-store beats letting the browser guess from a heuristic.
 */
const NO_STORE = "no-store, must-revalidate";

/**
 * Only these package subtrees are reachable over HTTP. xterm and the Radix
 * colour scales are served from node_modules so the tool runs offline with no
 * CDN and no bundler; everything else stays unreachable.
 */
const VENDOR_MAP: Record<string, string> = {
  "/vendor/xterm.js": "@xterm/xterm/lib/xterm.js",
  "/vendor/xterm-addon-fit.js": "@xterm/addon-fit/lib/addon-fit.js",
  "/vendor/xterm.css": "@xterm/xterm/css/xterm.css",
  "/vendor/radix/gray/dark.css": "@radix-ui/colors/gray-dark.css",
  "/vendor/radix/blue/dark.css": "@radix-ui/colors/blue-dark.css",
  "/vendor/radix/green/dark.css": "@radix-ui/colors/green-dark.css",
  "/vendor/radix/amber/dark.css": "@radix-ui/colors/amber-dark.css",
  "/vendor/radix/red/dark.css": "@radix-ui/colors/red-dark.css",
  "/vendor/radix/cyan/dark.css": "@radix-ui/colors/cyan-dark.css",
  "/vendor/radix/iris/dark.css": "@radix-ui/colors/iris-dark.css",
};

const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

const readBody = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

export interface Adapter {
  listSessions(): Promise<any[]>;
  createSession(directory: string): Promise<string>;
  sendPrompt(sessionId: string, text: string): Promise<unknown>;
  messages(sessionId: string): Promise<any[]>;
  pendingPermissions(): Promise<any[]>;
  resolvePermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<boolean>;
}

export function startServer(bus: EventBus, adapter: Adapter, port: number) {
  const store = new WorkspaceStore();
  const pool = new PtyPool();

  // The opencode SDK server is no longer needed to serve the UI -- agents run
  // inside the PTYs now. Its endpoints stay available, but the upstream server
  // is started on first use so a terminal-only session costs nothing.
  let starting: Promise<void> | null = null;
  const ensureAdapter = async () => {
    if (!starting) starting = (adapter as any).start?.() ?? Promise.resolve();
    return starting;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      // ---- SSE to browser: one connection, every session -----------------
      if (path === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const send = (e: NormalizedEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        // writeHead alone does not put a single byte on the wire, and the first
        // event may never come: the adapter starts lazily, so a terminal-only
        // Warden has an empty history and no live events until an agent is
        // launched. Without this the browser sits on "connecting" for a full
        // ping interval before EventSource sees the response at all.
        res.flushHeaders();
        for (const e of bus.history()) send(e);
        const off = bus.subscribe(send);
        const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
        req.on("close", () => {
          clearInterval(beat);
          off();
        });
        return;
      }

      if (path === "/api/sessions" && req.method === "GET") {
        await ensureAdapter();
        return json(res, 200, await adapter.listSessions());
      }

      if (path === "/api/sessions" && req.method === "POST") {
        const { directory } = await readBody(req);
        if (!directory) return json(res, 400, { error: "directory required" });
        await ensureAdapter();
        return json(res, 200, { id: await adapter.createSession(directory) });
      }

      const prompt = path.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
      if (prompt && req.method === "POST") {
        const { text } = await readBody(req);
        if (!text) return json(res, 400, { error: "text required" });
        // Fire and forget: promptAsync returns immediately, events follow.
        await adapter.sendPrompt(decodeURIComponent(prompt[1]), String(text));
        return json(res, 202, { ok: true });
      }

      const msgs = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (msgs && req.method === "GET") {
        const arr: any[] = await adapter.messages(decodeURIComponent(msgs[1]));
        // Flatten to something a log view can render without walking parts.
        return json(
          res,
          200,
          arr.flatMap((m) =>
            (m.parts ?? []).map((p: any) =>
              p.type === "text"
                ? { kind: "text", text: p.text }
                : p.type === "tool"
                  ? { kind: "tool", tool: p.tool, status: p.state?.status, input: p.state?.input, output: p.state?.output }
                  : { kind: p.type },
            ),
          ),
        );
      }

      if (path === "/api/permissions" && req.method === "GET") {
        return json(res, 200, await adapter.pendingPermissions());
      }

      const perm = path.match(/^\/api\/permissions\/([^/]+)$/);
      if (perm && req.method === "POST") {
        const { sessionId, response } = await readBody(req);
        if (!sessionId || !response) return json(res, 400, { error: "sessionId and response required" });
        const r = ["once", "always", "reject"].includes(response) ? response : "reject";
        await adapter.resolvePermission(sessionId, decodeURIComponent(perm[1]), r as any);
        return json(res, 200, { ok: true, response: r });
      }

      // ---- live agents in a workspace (read-only) -------------------------
      // Liveness comes from the process table, scope from the workspace id the
      // client already has. The path is resolved server-side: taking it as a
      // query parameter would let a caller point this at any directory.
      const live = url.pathname === "/api/live" ? url.searchParams.get("workspaceId") : null;
      if (live) {
        const ws = await store.get(live);
        if (!ws) return json(res, 404, { error: "workspace not found" });
        const history = await buildAgentGraph();
        const shellPids = new Map<number, string>();
        for (const t of pool.list()) {
          if (t.pid && t.alive) shellPids.set(t.pid, t.id);
        }
        const agents = await detectLiveAgents({
          workspacePath: ws.path,
          shellPids,
          sessions: history.nodes,
        });
        // Subagent sessions have no process of their own -- they run inside the
        // parent TUI -- so they can never be "live". They are returned separately
        // and the client only draws them when the user asks for them, rather than
        // passing them off as running agents.
        const childOf = new Map(agents.map(a => [a.sessionId, a.pid]));
        const subagents = history.nodes.filter(
          n => n.parentId && childOf.has(n.parentId) && !childOf.has(n.id),
        );
        return json(res, 200, {
          workspace: { id: ws.id, name: ws.name, path: ws.path },
          agents,
          subagents: subagents.map(n => ({
            id: n.id,
            title: n.title,
            runtime: n.runtime,
            parentId: n.parentId,
            updated: n.updated,
            tokens: n.tokens,
          })),
        });
      }

      // ---- agent graph (read-only) -----------------------------------------
      if (path === "/api/graph") {
        // Layout is deterministic server-side, so the browser only draws. It
        // also means the node positions are stable across polls and reloads.
        const graph = await buildAgentGraph();
        const pos = layout(
          graph.nodes.map(n => ({ id: n.id, parentId: n.parentId })),
          graph.edges,
          1600,
          1000,
        );
        const active = new Map(graph.nodes.map(n => [n.id, n.active]));
        return json(res, 200, {
          nodes: graph.nodes,
          edges: graph.edges,
          sources: graph.sources,
          positions: Object.fromEntries(
            pos.map(p => [
              p.id,
              {
                x: Math.round(p.x),
                y: Math.round(p.y),
                r: p.radius,
                depth: p.depth,
                active: active.get(p.id) ?? false,
              },
            ]),
          ),
          size: { w: 1600, h: 1000 },
        });
      }

      if (await handleWorkspaceRoutes(path, req.method ?? "GET", req, res, store, pool)) return;

      for (const name of ["app.js", "graph.js"]) {
        if (path === `/${name}`) {
          const body = await readFile(join(UI, name), "utf8");
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": NO_STORE });
          return res.end(body);
        }
      }

      if (path === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }

      if (path === "/" || path === "/index.html") {
        const html = await readFile(join(UI, "index.html"), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": NO_STORE });
        return res.end(html);
      }

      // Static assets, mapped explicitly rather than by path walking: a
      // lookup table cannot be talked into reading ../../.ssh/id_rsa.
      const asset = VENDOR_MAP[path];
      if (path.startsWith("/vendor/")) {
        if (!asset) return json(res, 404, { error: "not found" });
        const file = join(ROOT, "node_modules", asset);
        const type = asset.endsWith(".css") ? "text/css" : "text/javascript";
        try {
          const body = await readFile(file);
          res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
          return res.end(body);
        } catch {
          return json(res, 404, { error: "not found" });
        }
      }

      return json(res, 404, { error: "not found" });
    } catch (e: any) {
      console.error("[warden]", path, e);
      return json(res, 500, { error: e?.message ?? "internal error" });
    }
  });

  attachTerminalSocket(server, pool);
  // Shells are child processes; without this they outlive Warden on a crash.
  const cleanup = () => {
    pool.killAll();
    server.close();
  };
  process.once("exit", cleanup);

  return listenWithFallback(server, port);
}

class PortBusyError extends Error {
  // Declared explicitly: Node's strip-only TS mode rejects parameter properties.
  port: number;
  constructor(port: number) {
    super(`port ${port} is already in use`);
    this.name = "PortBusyError";
    this.port = port;
  }
}

/**
 * Binds the server, walking forward from `port` when it is taken so a stale
 * Warden (or anything else on the machine) can't block startup. An explicitly
 * requested WARDEN_PORT is respected strictly -- silently landing somewhere
 * else would leave the user staring at the wrong URL.
 */
function listenWithFallback(server: Server, port: number, attempts = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    let candidate = port;
    let tries = 0;

    const onError = (e: NodeJS.ErrnoException) => {
      if (e.code !== "EADDRINUSE") return server.removeListener("error", onError), reject(e);
      server.removeListener("error", onError);
      if (++tries > attempts) return reject(new PortBusyError(port));
      candidate++;
      server.once("error", onError);
      server.listen(candidate, "127.0.0.1");
    };

    server.once("error", onError);
    server.listen(candidate, "127.0.0.1", () => {
      server.removeListener("error", onError);
      // Surface later runtime errors (e.g. socket close) instead of crashing silently.
      server.on("error", e => console.error("[warden] server error:", e.message));
      resolve(candidate);
    });
  });
}
