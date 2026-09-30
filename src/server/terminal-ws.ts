/**
 * WebSocket bridge for terminal I/O.
 *
 * SSE is one-directional and the browser needs a real duplex byte stream, so
 * terminals get their own socket. Kept separate from the event bus on purpose:
 * an agent event stream should never be able to block on terminal backpressure.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import type { PtyPool, Terminal } from "../pty/pool.ts";

interface Client {
  socket: WebSocket;
  termId: string;
  alive: boolean;
}

export function attachTerminalSocket(server: Server, pool: PtyPool) {
  const wss = new WebSocketServer({ server, path: "/ws/terminal" });
  const clients = new Map<WebSocket, Client>();

  const send = (socket: WebSocket, payload: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };

  pool.onData = (term, data) => {
    for (const c of clients.values()) {
      if (c.termId === term.id) send(c.socket, { type: "data", data });
    }
  };

  pool.onExit = (term, code) => {
    for (const c of clients.values()) {
      if (c.termId === term.id) {
        send(c.socket, { type: "exit", code });
        c.socket.close();
      }
    }
  };

  wss.on("connection", (socket) => {
    let term: Terminal | null = null;
    const client: Client = { socket, termId: "", alive: true };
    clients.set(socket, client);

    socket.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(socket, { type: "error", message: "invalid JSON" });
      }

      try {
        if (msg.type === "attach") {
          const t = pool.get(msg.terminalId);
          if (!t) return send(socket, { type: "error", message: "terminal not found" });
          term = t;
          client.termId = t.id;
          // Replay so a reload lands in a live shell, not an empty box.
          send(socket, { type: "replay", data: t.scrollback, alive: t.alive });
          send(socket, { type: "ready", terminalId: t.id });
          return;
        }
        if (msg.type === "input") {
          if (term) pool.write(term.id, msg.data);
          return;
        }
        if (msg.type === "resize") {
          if (term) pool.resize(term.id, msg.cols, msg.rows);
          return;
        }
      } catch (e: any) {
        send(socket, { type: "error", message: e?.message ?? "terminal error" });
      }
    });

    const cleanup = () => {
      client.alive = false;
      clients.delete(socket);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    // Drop dead clients so a closed laptop lid can't leak sockets.
    const ping = setInterval(() => {
      if (!client.alive) return clearInterval(ping);
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 30_000);
    socket.on("close", () => clearInterval(ping));
  });

  return wss;
}
