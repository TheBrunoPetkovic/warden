import { createServer } from "node:net";
import { createOpencodeServer } from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { EventBus, NormalizedEvent, SessionInfo } from "../core/events.ts";

/**
 * opencode adapter.
 *
 * Design constraints, all established by spike and recorded in
 * docs/spike-findings.md:
 *
 *  - Two clients are required. The v2 client silently drops request bodies,
 *    so every write goes through v1. v2 is used only for the event stream.
 *  - Port 0 is ignored by createOpencodeServer, so we allocate one ourselves.
 *  - One global SSE stream carries every session; we filter by sessionID.
 *    The per-session `v2.session.events` endpoint returns an empty stream.
 *  - `session.prompt()` blocks until the turn ends, which deadlocks any UI
 *    waiting on a human approval. Always `promptAsync`.
 *  - Permission replies go over raw fetch; the SDK method drops the body.
 */

const NOISE = new Set(["plugin.added", "catalog.updated", "server.heartbeat", "server.connected", "reference.updated", "integration.updated"]);

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

const truncate = (s: unknown, n = 400) => {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t && t.length > n ? t.slice(0, n) + "…" : (t ?? "");
};

export class OpencodeAdapter {
  #bus: EventBus;
  #url = "";
  #ac = new AbortController();
  #client: any;
  #v2: any;
  #sessions = new Map<string, SessionInfo>();
  #dirSubs = new Set<string>();

  constructor(bus: EventBus) {
    this.#bus = bus;
  }

  get url() {
    return this.#url;
  }

  emit(e: NormalizedEvent) {
    this.#bus.publish(e);
  }

  #started = false;

  async start() {
    // Idempotent: the lazy route guard can race with a retry.
    if (this.#started) return;
    this.#started = true;
    const port = await freePort();
    const server = await createOpencodeServer({ hostname: "127.0.0.1", port, signal: this.#ac.signal });
    this.#url = server.url;
    this.#client = createOpencodeClient({ baseUrl: server.url });
    this.#v2 = createOpencodeClient({ baseUrl: server.url });
    this.emit({ kind: "runtime.log", at: Date.now(), runtime: "opencode", level: "info", message: `server up on ${server.url}` });
    // The server's own cwd is where sessions land when none is specified.
    this.subscribeDir(process.cwd());
  }

  async stop() {
    this.#ac.abort();
  }

  /**
   * `event.subscribe` is scoped by directory — a bare subscription only sees
   * the server's cwd. Sessions live wherever the user pointed them, so each
   * directory needs its own subscription. The same applies to permission.list.
   * Session events are fanned in; the UI still sees one flat stream.
   */
  subscribeDir(directory: string) {
    if (!directory || this.#dirSubs.has(directory)) return;
    this.#dirSubs.add(directory);
    void this.#pump(directory);
  }

  async #pump(directory: string) {
    try {
      const sub: any = await this.#v2.event.subscribe({ directory });
      for await (const ev of sub.stream as AsyncIterable<any>) {
        if (NOISE.has(ev?.type)) continue;
        this.#normalize(ev);
      }
      this.emit({ kind: "runtime.log", at: Date.now(), runtime: "opencode", level: "warn", message: `stream closed for ${directory}` });
    } catch (e: any) {
      this.emit({ kind: "runtime.log", at: Date.now(), runtime: "opencode", level: "error", message: `stream failed for ${directory}: ${e?.message ?? e}` });
      this.#dirSubs.delete(directory);
    }
  }

  #normalize(ev: any) {
    const at = Date.now();
    const p = ev?.properties ?? {};
    const sid: string | undefined = p.sessionID;
    const t: string = ev?.type;

    switch (t) {
      case "session.created":
      case "session.updated": {
        const info = p.info ?? {};
        const id = info.id ?? sid;
        if (!id) return;
        const prev = this.#sessions.get(id);
        const s: SessionInfo = {
          runtime: "opencode",
          id,
          title: info.title || prev?.title || id,
          directory: info.directory ?? prev?.directory ?? "",
          status: prev?.status ?? "idle",
          cost: info.cost ?? prev?.cost ?? 0,
          tokens: info.tokens?.total ?? prev?.tokens ?? 0,
        };
        this.#sessions.set(id, s);
        this.emit({ kind: "session.created", at, runtime: "opencode", session: s });
        return;
      }
      case "session.status": {
        if (!sid) return;
        const st = p.status?.type;
        const status = st === "busy" ? "busy" : st === "retry" ? "retry" : "idle";
        const prev = this.#sessions.get(sid);
        if (prev) prev.status = status;
        this.emit({ kind: "session.status", at, runtime: "opencode", sessionId: sid, status, detail: p.status?.message });
        return;
      }
      case "session.idle": {
        if (sid) this.emit({ kind: "session.idle", at, runtime: "opencode", sessionId: sid });
        return;
      }
      case "message.part.delta": {
        if (!sid || p.delta == null) return;
        this.emit({ kind: "text.delta", at, runtime: "opencode", sessionId: sid, messageId: p.messageID, partId: p.partID, text: String(p.delta) });
        return;
      }
      case "message.part.updated": {
        const part = p.part ?? {};
        if (!sid) return;
        if (part.type === "text" && part.text) {
          this.emit({ kind: "text.done", at, runtime: "opencode", sessionId: sid, messageId: part.messageID, partId: part.id, text: String(part.text) });
        } else if (part.type === "tool") {
          const st = part.state?.status;
          const callId = part.callID ?? part.id;
          const tool = part.tool ?? "tool";
          if (st === "running" || st === "pending") {
            this.emit({ kind: "tool.started", at, runtime: "opencode", sessionId: sid, callId, tool, input: part.state?.input });
          } else if (st) {
            this.emit({
              kind: "tool.completed",
              at,
              runtime: "opencode",
              sessionId: sid,
              callId,
              tool,
              status: st,
              output: truncate(part.state?.output ?? part.state?.error),
            });
          }
        }
        return;
      }
      case "permission.asked": {
        const meta = p.metadata ?? {};
        this.emit({
          kind: "permission.requested",
          at,
          runtime: "opencode",
          request: {
            permissionId: p.id,
            sessionId: p.sessionID,
            kind: p.permission,
            summary: meta.command ?? meta.filePath ?? p.patterns?.join(" ") ?? p.permission,
            alwaysPattern: p.always?.[0],
            raw: p,
          },
        });
        return;
      }
      case "permission.replied": {
        if (sid) this.emit({ kind: "permission.resolved", at, runtime: "opencode", sessionId: sid, permissionId: p.requestID, response: p.reply });
        return;
      }
      case "session.diff": {
        if (sid) this.emit({ kind: "diff", at, runtime: "opencode", sessionId: sid, diff: p.diff });
        return;
      }
      case "message.updated": {
        const info = p.info ?? {};
        const prev = sid ? this.#sessions.get(sid) : undefined;
        if (prev && typeof info.cost === "number") {
          prev.cost = info.cost;
          prev.tokens = info.tokens?.total ?? prev.tokens;
        }
        return;
      }
      default:
        return;
    }
  }

  // ---- outward API -------------------------------------------------------

  async listSessions() {
    const r: any = await this.#client.session.list({});
    const arr = r?.data?.data ?? r?.data ?? [];
    for (const s of arr) {
      const prev = this.#sessions.get(s.id);
      const info: SessionInfo = {
        runtime: "opencode",
        id: s.id,
        title: s.title || prev?.title || s.id,
        directory: s.directory ?? prev?.directory ?? "",
        status: prev?.status ?? "idle",
        cost: s.cost ?? prev?.cost ?? 0,
        tokens: s.tokens?.total ?? prev?.tokens ?? 0,
      };
      this.#sessions.set(s.id, info);
      this.subscribeDir(info.directory);
    }
    return [...this.#sessions.values()];
  }

  /** Look up a single session by id, for restoring state on startup. */
  async getSession(id: string) {
    const cached = this.#sessions.get(id);
    if (cached) return cached;
    const r: any = await this.#client.session.get({ id }).catch(() => null);
    const s = r?.data;
    if (!s?.id) return null;
    const info: SessionInfo = {
      runtime: "opencode",
      id: s.id,
      title: s.title || s.id,
      directory: s.directory ?? "",
      status: "idle",
      cost: s.cost ?? 0,
      tokens: s.tokens?.total ?? 0,
    };
    this.#sessions.set(id, info);
    this.subscribeDir(info.directory);
    return info;
  }

  async createSession(directory: string) {
    this.subscribeDir(directory);
    const r: any = await this.#client.session.create({ directory });
    const id = r?.data?.id;
    if (id) {
      const s: SessionInfo = {
        runtime: "opencode",
        id,
        title: r.data.title || id,
        directory: r.data.directory ?? directory,
        status: "idle",
        cost: 0,
        tokens: 0,
      };
      this.#sessions.set(id, s);
      this.emit({ kind: "session.created", at: Date.now(), runtime: "opencode", session: s });
    }
    return id as string;
  }

  async sendPrompt(sessionId: string, text: string) {
    return this.#client.session.promptAsync({ sessionID: sessionId, parts: [{ type: "text", text }] });
  }

  async messages(sessionId: string) {
    const r: any = await this.#client.session.messages({ sessionID: sessionId });
    return r?.data ?? [];
  }

  /**
   * `permission.list` is scoped by directory. The client itself has no
   * directory set, so querying bare would search the server's own cwd and
   * return [] even while a session in another directory is blocked. Sessions
   * span directories, so fan out over the ones we know about.
   */
  async pendingPermissions() {
    const dirs = new Set<string>();
    for (const s of this.#sessions.values()) if (s.directory) dirs.add(s.directory);
    if (!dirs.size) return [];

    const all: any[] = [];
    for (const directory of dirs) {
      try {
        const r: any = await this.#client.permission.list({ directory });
        for (const p of r?.data ?? []) all.push(p);
      } catch {
        // A directory that no longer exists is not worth failing the whole sweep.
      }
    }
    return all;
  }

  /** Raw fetch on purpose: client.permission.respond drops the body. */
  async resolvePermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject") {
    const res = await fetch(`${this.#url}/session/${sessionId}/permissions/${permissionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response }),
    });
    if (!res.ok) throw new Error(`permission reply failed: ${res.status} ${await res.text()}`);
    return true;
  }
}
