// Warden UI: a workspace rail on the left, real PTY terminals on the right.
//
// Terminals are the only surface. There is no chat panel by design -- agents
// are launched and driven the way you would in any other terminal, and Warden
// just hosts the PTY and keeps the shells alive across reloads.
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
}

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

const state = {
  workspaces: [],
  activeWs: null,   // workspace shown in the terminal column
  // Terminals are tracked per workspace so switching away and back restores the
  // same shells. A shell is a child process; dropping the view without killing
  // it would leave an orphan nothing can reach.
  terms: new Map(),  // workspaceId -> Terminal[]
  activeTerm: null,
  // Terminal docked inside the agents view. Null means the agents view is showing
  // no shell and the agent list has the column to itself.
  sideTerm: null,
};

const terminals = () => state.terms.get(state.activeWs) ?? [];

/**
 * Terminals live on the server and outlive the page, so the client has to ask
 * for them rather than trust what it created this session. Without this a
 * reload left the agent list pointing at terminal ids the page had never seen,
 * and every "open this agent" failed with "not in this workspace".
 */
async function syncTerminals(wsId) {
  const all = await api("/api/terminals").catch(() => []);
  const mine = all
    .filter(t => t.workspaceId === wsId)
    .map(t => ({ id: t.id, workspaceId: t.workspaceId, dead: !t.alive }));
  state.terms.set(wsId, mine);
  return mine;
}

// ------------------------------------------------------------------ workspaces

async function loadWorkspaces() {
  state.workspaces = await api("/api/workspaces");
  if (state.activeWs && !state.workspaces.some(w => w.id === state.activeWs)) {
    teardownTerminals();
    state.activeWs = null;
  }
  renderRail();
  renderStatus();
}

function renderRail() {
  const list = $("#wslist");
  list.replaceChildren();
  for (const w of state.workspaces) {
    const row = el("div", "ws" + (w.id === state.activeWs ? " sel" : "") + (w.missing ? " gone" : ""));
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    const body = el("div", "body");
    body.append(el("div", "name", w.name), el("div", "path", w.path));

    const kill = el("button", "kill", "×");
    kill.title = w.missing ? `Forget ${w.name} (its directory is gone)` : `Delete ${w.name}`;
    kill.setAttribute("aria-label", kill.title);
    kill.onclick = async ev => {
      ev.stopPropagation();
      // A workspace whose directory is already gone has nothing to confirm --
      // there is no data left to lose, only a stale record to drop.
      const ok = w.missing || confirm(
        `Delete workspace "${w.name}"?\n\nIts directory and any running terminals are removed. This cannot be undone.`,
      );
      if (!ok) return;
      try {
        // Tear down the local view first and without DELETE calls: removing the
        // workspace already killed its terminals server-side, and re-issuing
        // the deletes produces 404s that Chrome logs as console errors.
        if (state.activeWs === w.id) { teardownTerminals(); state.activeWs = null; }
        await api(`/api/workspaces/${w.id}`, { method: "DELETE" });
        await loadWorkspaces();
        renderTabs();
      } catch (e) { toast(e.message); }
    };

    row.append(body, kill);
    if (w.missing) {
      // The registry is a file and the directories are not, so a record can
      // outlive its directory. Saying so beats letting a selection fail later
      // with "workspace directory is gone" from a click that looked harmless.
      row.title = `Directory not found: ${w.path}`;
      row.onclick = () => toast(`"${w.name}" — its directory no longer exists.`);
    } else {
      row.onclick = () => openWorkspace(w.id);
    }
    row.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); } };
    list.append(row);
  }
  $("#wscount").textContent = state.workspaces.length || "";
  const gone = state.workspaces.filter(w => w.missing).length;
  $("#summary").textContent = state.workspaces.length
    ? `${state.workspaces.length} workspace${state.workspaces.length > 1 ? "s" : ""}` +
      (gone ? ` · ${gone} missing` : "")
    : "";
}

$("#newws").onsubmit = async ev => {
  ev.preventDefault();
  const input = $("#wsname");
  const name = input.value.trim();
  if (!name) return;
  try {
    const w = await api("/api/workspaces", { method: "POST", body: { name } });
    input.value = "";
    await loadWorkspaces();
    await openWorkspace(w.id);
  } catch (e) { toast(e.message); }
};

async function openWorkspace(id) {
  if (state.activeWs === id) return;
  // Re-checked here, not only in the click handler: a directory can be removed
  // after the rail rendered but before the click lands, and the spawn is what
  // actually fails.
  const ws = state.workspaces.find(w => w.id === id);
  if (!ws) return;
  if (ws.missing) {
    toast(`"${ws.name}" — its directory no longer exists.`);
    return;
  }
  // Keep the outgoing view mounted only long enough to detach; its shell stays
  // alive on the server and is re-attached when the user comes back.
  dropView();
  state.activeWs = id;
  state.sideTerm = null;
  renderRail();
  // The agents canvas is scoped to one workspace, so it has to follow the rail
  // even while the terminal column is the one on screen.
  setGraphWorkspace?.(id);

  const existing = await syncTerminals(id);
  state.activeTerm = existing[0]?.id ?? null;
  renderTabs();

  if (existing.length) mount(existing[0], $("#screen"));
  else { teardownScreen(); await newTerminal(); }
  renderStatus();
}

// -------------------------------------------------------------------- tabs

function renderTabs() {
  const bar = $("#tabs");
  bar.replaceChildren();
  terminals().forEach((t, i) => {
    const tab = el("div", "tab" + (t.id === state.activeTerm ? " sel" : "") + (t.dead ? " dead" : ""));
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(t.id === state.activeTerm));
    const pip = el("span", "pip");
    pip.title = t.dead ? "exited" : "running";
    const label = el("span", "label", t.name || `shell ${i + 1}`);
    const close = el("button", "close", "×");
    close.title = "Close terminal";
    close.onclick = async ev => {
      ev.stopPropagation();
      await api(`/api/terminals/${t.id}`, { method: "DELETE" }).catch(() => {});
      await dropTerminal(t.id);
    };
    tab.append(pip, label, close);
    tab.onclick = () => { state.activeTerm = t.id; renderTabs(); mount(t, $("#screen")); };
    bar.append(tab);
  });

  if (state.workspaces.some(w => w.id === state.activeWs)) {
    const add = el("div", "tab add");
    const b = el("button", "icon-btn", "+");
    b.title = "New terminal";
    b.setAttribute("aria-label", "New terminal");
    b.onclick = () => newTerminal();
    add.append(b);
    bar.append(add);
  }
}

function renderStatus() {
  const w = state.workspaces.find(x => x.id === state.activeWs);
  $("#statuspath").textContent = w ? w.path : "";
}

// ---------------------------------------------------------------- terminals

async function dropTerminal(id) {
  const list = terminals();
  const wasActive = state.activeTerm === id;
  const next = list.filter(t => t.id !== id);
  state.terms.set(state.activeWs, next);
  // Closing the shell that is docked leaves the panel pointing at nothing, so it
  // has to go back to the agent list before anything tries to mount into it.
  if (state.sideTerm === id) undock();
  if (wasActive) {
    const pick = next[0] ?? null;
    state.activeTerm = pick?.id ?? null;
    if (pick) mount(pick, $("#screen"));
    else teardownScreen();
  }
  renderTabs();
  renderStatus();
}

function teardownScreen() {
  dropView();
  $("#screen").replaceChildren();
  if (!state.workspaces.some(w => w.id === state.activeWs)) return;
  const empty = el("div", null);
  empty.id = "empty";
  const p1 = el("div", null, "No terminals in this workspace");
  const p2 = el("div");
  p2.append("Launch an agent with ", el("code", null, "opencode"), " — or any command.");
  empty.append(p1, p2);
  $("#screen").append(empty);
}

async function newTerminal() {
  if (!state.activeWs) return;
  const w = state.workspaces.find(x => x.id === state.activeWs);
  const cols = current?.term?.cols ?? 80;
  const rows = current?.term?.rows ?? 24;
  try {
    const t = await api("/api/terminals", {
      method: "POST",
      body: { workspaceId: state.activeWs, cols, rows },
    });
    t.name = "";
    t.dead = false;
    const list = terminals();
    list.push(t);
    state.terms.set(state.activeWs, list);
    state.activeTerm = t.id;
    // A new shell is always for the full-width terminal column. Leaving the panel
    // docked while it shows a different shell than the tab bar would make the
    // two surfaces disagree about what is selected.
    undock();
    renderTabs();
    mount(t, $("#screen"));
    renderStatus();
  } catch (e) { toast(`terminal: ${e.message}`); }
}

/** Detaches the view and forgets the terminals of the active workspace. */
function teardownTerminals() {
  dropView();
  state.sideTerm = null;
  $("#sidepanel").hidden = true;
  $("#agentlist").hidden = false;
  if (state.activeWs) state.terms.delete(state.activeWs);
  state.activeTerm = null;
  teardownScreen();
  renderTabs();
}

// One xterm instance at a time, hosted by a single div that gets re-parented
// rather than rebuilt. The agents view docks a terminal by moving this host into
// the side panel; a second instance would mean a second socket and a second
// copy of the scrollback, and the two would drift.
let current = null;
let host = null;

function dropView() {
  if (current) { current.sock?.close(); current.term?.dispose(); current = null; }
  host?.remove();
  host = null;
}

function ensureHost(container) {
  if (!host) {
    host = el("div");
    host.style.height = "100%";
  }
  if (host.parentElement !== container) container.appendChild(host);
  return host;
}

function setStatusForTerm(t) {
  const ws = state.workspaces.find(x => x.id === state.activeWs);
  $("#statuspath").textContent = `${ws?.path ?? ""}  ·  ${t.id}`;
}

/**
 * Shows terminal `t` inside `container`. The host is moved rather than
 * recreated, so an already-open terminal keeps its scrollback, its socket and
 * its selection when it is docked or undocked.
 */
function mount(t, container) {
  const target = ensureHost(container);
  if (current?.id !== t.id) {
    if (current) { current.sock?.close(); current.term?.dispose(); current = null; }
    target.replaceChildren();
    current = createView(t, target);
  }
  // The host may have just come out of a display:none subtree, and fit() against a
  // hidden element measures zero — the PTY would end up 1x1 until the next resize.
  requestAnimationFrame(() => current?.refit?.());
  setStatusForTerm(t);
}

function createView(t, target) {
  const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12.5,
    lineHeight: 1.2,
    scrollback: 10000,
    allowProposedApi: true,
    theme: {
      background: "#111318",
      foreground: "var(--gray-12)",
      cursor: "var(--blue-9)",
      selectionBackground: "var(--blue-5)",
      black: "#111318",
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(target);
  fit.fit();
  term.focus();

  const entry = { id: t.id, term, fit, sock: null, replaying: true, refit: null };

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws/terminal`);
  entry.sock = sock;

  sock.onopen = () => sock.send(JSON.stringify({ type: "attach", terminalId: t.id }));
  sock.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === "replay") {
      term.reset();
      if (m.data) term.write(m.data);
      entry.replaying = false;
      term.focus();
    } else if (m.type === "data") {
      term.write(m.data);
    } else if (m.type === "exit") {
      term.writeln(`\r\n\x1b[2m[exited with code ${m.code}]\x1b[0m`);
      t.dead = true;
      renderTabs();
    } else if (m.type === "error") {
      toast(`terminal: ${m.message}`);
    }
  };
  sock.onclose = () => {
    // A closed socket means this browser detached, not that the shell exited.
    // The server sends an explicit "exit" when the process really ends; treating
    // onclose as death marked live terminals dead on every reload and workspace
    // switch, and the agents view then refused to open them.
  };
  sock.onerror = () => toast("terminal socket error");

  term.onData(d => {
    // Keystrokes sent before the replay lands would arrive ahead of the
    // shell prompt and get dropped on the floor.
    if (sock.readyState === WebSocket.OPEN && !entry.replaying) {
      sock.send(JSON.stringify({ type: "input", data: d }));
    }
  });

  const pushSize = () => {
    if (sock.readyState !== WebSocket.OPEN) return;
    fit.fit();
    sock.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };
  term.onResize(pushSize);
  new ResizeObserver(pushSize).observe(target);
  // kept so re-parenting the host can re-measure without rebuilding the terminal
  // and losing its scrollback
  entry.refit = pushSize;
  pushSize();

  return entry;
}

// ------------------------------------------------------------------- runtime

// The event stream no longer drives any UI: with terminals as the only
// surface there is nothing to render from it. The connection is kept purely
// so the header can report whether the backend is alive.
function watchBackend() {
  const es = new EventSource("/api/stream");
  const dot = $("#dot");
  const label = $("#conn");
  es.onopen = () => { dot.classList.add("live"); label.textContent = "connected"; };
  es.onerror = () => { dot.classList.remove("live"); label.textContent = "reconnecting"; };
}

// ------------------------------------------------------------ docked side panel

/**
 * Docks an agent's shell in the agents view.
 *
 * A node's only real handle on the thing it describes is the terminal it runs in,
 * but switching the whole column over to that terminal means losing the canvas
 * you clicked to get there. So the xterm host is re-parented into the side panel
 * and the view stays exactly where it was.
 */
function openTerminal(termId, node) {
  const t = terminals().find(x => x.id === termId);
  if (!t) return toast(`terminal ${termId} is no longer in this workspace`);
  if (t.dead) return toast(`terminal ${termId} has exited`);

  state.activeTerm = t.id;
  state.sideTerm = t.id;
  $("#side-title").textContent = node?.title ?? t.name ?? t.id;
  $("#side-meta").textContent = node?.live ? `${node.runtime} · pid ${node.pid}` : t.id;
  $("#sidepanel").hidden = false;
  // The list is the launcher; once it has fired, the width is better spent on
  // what it launched.
  $("#agentlist").hidden = true;
  renderTabs();
  mount(t, $("#sideterm"));
  setSelectedNode?.(node ?? null);
  relayoutGraph?.();
}

/** Hands the column back to the agent list and tears the docked view down. */
function undock() {
  if (!state.sideTerm) return;
  state.sideTerm = null;
  $("#sidepanel").hidden = true;
  $("#agentlist").hidden = false;
  $("#side-title").textContent = "";
  $("#side-meta").textContent = "";
  setSelectedNode?.(null);
  // Only the docked copy may be disposed: if the xterm is currently mounted in
  // the terminal column, closing the panel must not take that down with it. The
  // shell keeps running either way and the next mount replays its scrollback.
  if (host?.parentElement === $("#sideterm")) dropView();
  relayoutGraph?.();
}

const sidePanel = () => $("#sidepanel");
const clampSide = px =>
  Math.max(240, Math.min(px, Math.round($("#graphmain").clientWidth * 0.7)));
let sideW = 420;

function applySide(px) {
  sideW = clampSide(px);
  sidePanel().style.setProperty("--side-w", `${sideW}px`);
  $("#sidegrip").setAttribute("aria-valuenow", String(sideW));
}

$("#sidegrip").addEventListener("pointerdown", e => {
  e.preventDefault();
  const grip = $("#sidegrip");
  grip.setPointerCapture(e.pointerId);
  grip.classList.add("drag");
  const startX = e.clientX;
  const startW = sideW;
  const move = ev => applySide(startW - (ev.clientX - startX));
  const up = () => {
    grip.classList.remove("drag");
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
    // The ResizeObserver on the host sees the new width, but the PTY needs the
    // size pushed explicitly or the agent keeps rendering the old column count.
    requestAnimationFrame(() => current?.refit?.());
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
});

// A separator you can only drag is a separator a keyboard cannot reach.
$("#sidegrip").addEventListener("keydown", e => {
  // The panel sits to the right of the grip, so moving left widens it.
  const delta = e.key === "ArrowLeft" ? 24 : e.key === "ArrowRight" ? -24 : 0;
  if (!delta) return;
  e.preventDefault();
  applySide(sideW + delta);
  requestAnimationFrame(() => current?.refit?.());
});

$("#side-close").onclick = () => undock();

// Escape is deliberately NOT hijacked inside the terminal. xterm stops key
// propagation for every key it consumes, and once it has focus the docked content
// is an agent TUI where Escape closes dialogs and drives readline -- stealing it
// to close a panel would break the thing the panel exists to show. Instead the
// header is a real focus stop: clicking it moves focus out of the terminal, and
// from there Escape closes the panel.
$("#sidehead").onclick = () => $("#sidehead").focus();
$("#sidehead").onkeydown = e => { if (e.key === "Escape") undock(); };

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && state.sideTerm) undock();
});

// ------------------------------------------------------------------ view switch

// Terminals and the agent graph share the right column. The graph is a separate
// module so its canvas state and poll loop have their own lifetime.
let showGraph = null;
let hideGraph = null;
let setGraphWorkspace = null;
let setSelectedNode = null;
let relayoutGraph = null;

function setView(which) {
  const graphing = which === "graph";
  $("#termview").classList.toggle("on", !graphing);
  $("#graphview").classList.toggle("on", graphing);
  $("#vterm").setAttribute("aria-selected", String(!graphing));
  $("#vgraph").setAttribute("aria-selected", String(graphing));

  if (graphing) {
    $("#statuspath").textContent = "";
    showGraph?.(t => { $("#graphpath").textContent = t; }, state.activeWs, openTerminal);
  } else {
    // The side panel lives inside the agents view, so leaving it has to hand the
    // host back to the terminal column rather than leave it mounted in a
    // display:none subtree. The view switch also has to happen before mount() —
    // a fit() against a hidden element measures zero and the PTY ends up 1x1.
    undock();
    hideGraph?.();
    // Undocking disposes the view when the panel owned it, so the terminal column
    // can arrive here with nothing mounted. Re-mounting an already-live terminal
    // is a no-op, so this is also the cheap path for a plain tab round trip.
    const t = terminals().find(x => x.id === state.activeTerm);
    if (t && !t.dead) mount(t, $("#screen"));
    requestAnimationFrame(() => current?.refit?.());
  }
}

$("#vterm").onclick = () => setView("term");
$("#vgraph").onclick = () => setView("graph");

(async function init() {
  await loadWorkspaces();
  // Newest usable workspace, not simply the newest record. A record whose
  // directory is gone still sorts to the top, and auto-opening it would fail
  // the spawn on every page load while skipping the workspaces that still work.
  const last = state.workspaces.find(w => !w.missing);
  if (last) {
    state.activeWs = last.id;
    renderRail();
    const existing = await syncTerminals(last.id);
    if (existing.length) {
      state.activeTerm = existing[0].id;
      renderTabs();
      mount(existing[0], $("#screen"));
    } else {
      await newTerminal();
    }
  } else {
    teardownScreen();
    if (state.workspaces.length) {
      // Every record is broken. Say why on load rather than showing an empty
      // terminal panel with no explanation.
      toast("No usable workspace — every saved directory is missing.");
    }
  }
  watchBackend();
  // The graph module registers itself once parsed; wiring here keeps app.js
  // free of canvas internals.
  import("./graph.js").then(m => {
    showGraph = m.showGraph;
    hideGraph = m.hideGraph;
    setGraphWorkspace = m.setWorkspace;
    setSelectedNode = m.setSelected;
    relayoutGraph = m.relayout;
    if ($("#graphview").classList.contains("on")) setView("graph");
  });
})();

