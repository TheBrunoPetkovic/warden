import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/** One browser xterm attached to one Warden PTY. */
export function TerminalPane({ terminal, startupInput, onExit, onError }) {
  const host = useRef(null);
  const startup = useRef(startupInput);

  useEffect(() => {
    startup.current = startupInput;
  }, [startupInput]);

  useEffect(() => {
    if (!terminal || !host.current) return undefined;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.2,
      scrollback: 50000,
      allowProposedApi: true,
      theme: {
        background: "#111318",
        foreground: "#eeeeF0",
        cursor: "#0090ff",
        selectionBackground: "#214a70",
        black: "#111318",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    term.focus();

    let replaying = true;
    let disposed = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws/terminal`);
    socket.onopen = () => socket.send(JSON.stringify({ type: "attach", terminalId: terminal.id }));
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === "replay") {
        term.reset();
        if (message.data) term.write(message.data);
        replaying = false;
        term.focus();
      } else if (message.type === "ready") {
        // A resume command must come after replay. Otherwise a loaded shell can
        // receive it before its prompt and silently lose the first input.
        if (startup.current) {
          socket.send(JSON.stringify({ type: "input", data: startup.current }));
          startup.current = null;
        }
      } else if (message.type === "data") {
        term.write(message.data);
      } else if (message.type === "exit") {
        term.writeln(`\r\n\x1b[2m[exited with code ${message.code}]\x1b[0m`);
        onExit?.(terminal.id);
      } else if (message.type === "error") {
        onError?.(`terminal: ${message.message}`);
      }
    };
    // React Strict Mode mounts, cleans up, and mounts again in development.
    // Closing that first intentional socket must not look like a PTY failure.
    socket.onerror = () => { if (!disposed) onError?.("terminal socket error"); };
    const input = term.onData(data => {
      if (!replaying && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resize = () => {
      if (!host.current) return;
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const resizeSubscription = term.onResize(resize);
    resize();
    return () => {
      disposed = true;
      observer.disconnect();
      resizeSubscription.dispose();
      input.dispose();
      socket.close();
      term.dispose();
    };
  }, [terminal?.id, onError, onExit]);

  return <div className="terminal-host" ref={host} />;
}
