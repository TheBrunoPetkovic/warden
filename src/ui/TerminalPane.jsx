import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/** One browser xterm attached to one Warden PTY. */
export function TerminalPane({ terminal, startupInput, onExit, onError, appearance, settings }) {
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
      fontFamily: fontFor(settings?.fontFamily),
      fontSize: settings?.fontSize ?? 13,
      lineHeight: 1.2,
      scrollback: settings?.scrollback ?? 50000,
      cursorStyle: settings?.cursorStyle ?? "bar",
      cursorBlink: settings?.cursorBlink ?? true,
      allowProposedApi: true,
      theme: {
        background: css("--bg", "#111318"),
        foreground: css("--fg", "#eeeeF0"),
        cursor: css("--accent", "#0090ff"),
        selectionBackground: css("--raised", "#214a70"),
        black: css("--bg", "#111318"),
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
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const macos = settings?.keybinding === "macos" && event.metaKey;
      const vscode = settings?.keybinding === "vscode" && event.ctrlKey && event.shiftKey;
      if ((macos || vscode) && key === "c" && term.hasSelection()) {
        void navigator.clipboard?.writeText?.(term.getSelection());
        return false;
      }
      if ((macos || vscode) && key === "v") {
        const readClipboard = navigator.clipboard?.readText;
        if (readClipboard) void readClipboard.call(navigator.clipboard).then(text => term.paste(text)).catch(() => {});
        return false;
      }
      return true;
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
  }, [terminal?.id, onError, onExit, appearance?.theme, appearance?.scheme, settings?.fontFamily, settings?.fontSize, settings?.scrollback, settings?.cursorStyle, settings?.cursorBlink, settings?.keybinding]);

  return <div className="terminal-host" ref={host} />;
}

function css(variable, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
}

function fontFor(font) {
  if (font === "menlo") return "Menlo, ui-monospace, monospace";
  if (font === "jetbrains") return "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace";
  return "ui-monospace, SFMono-Regular, Menlo, monospace";
}
