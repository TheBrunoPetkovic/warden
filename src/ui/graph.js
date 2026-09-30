// Agents view: a read-only canvas of the agents that are actually running right
// now inside one workspace.
//
// Liveness is real, not inferred. The server reads the process table and scopes
// it to this workspace's directory, so a node here means a process exists --
// which is why polling is fast and why nothing on this view is ever "stale".
//
// Layout is a plain layered tree rather than a force simulation: the node count
// is whatever is running in one workspace, usually a handful, and a stable tree
// is far easier to read than a graph that rearranges itself every two seconds.

const $ = s => document.querySelector(s);
const cv = $("#graph");
const ctx = cv.getContext("2d");

const RUNTIME_VAR = { opencode: "var(--blue-9)", codex: "var(--green-9)", claude: "var(--iris-9)" };
const colorCache = new Map();
function cssColor(v) {
  if (colorCache.has(v)) return colorCache.get(v);
  const probe = document.createElement("span");
  probe.style.color = v;
  document.body.appendChild(probe);
  const got = getComputedStyle(probe).color;
  probe.remove();
  colorCache.set(v, got);
  return got;
}
const runtimeColor = r => cssColor(RUNTIME_VAR[r] ?? "var(--gray-9)");

let data = { workspace: null, agents: [], subagents: [] };
let nodes = [];
let edges = [];
let selected = null;
let detailFor = null;
let workspaceId = null;
let showSubagents = false;
let onViewChange = null;
let openTerminal = null;
let view = { x: 0, y: 0, k: 1 };
let fitted = false;

// ------------------------------------------------------------------ layout

/**
 * Layered tree: depth 0 on top, each layer centred as a row. With a handful of
 * nodes this reads instantly, and it is identical on every poll so the graph
 * does not twitch while you are looking at it.
 */
function layoutTree(width, height) {
  const depthOf = new Map();
  const depth = n => {
    if (depthOf.has(n.id)) return depthOf.get(n.id);
    const d = n.parentId && nodes.some(p => p.id === n.parentId) ? depth(n.nodes.find(p => p.id === n.parentId)) + 1 : 0;
    depthOf.set(n.id, d);
    return d;
  };
  const layers = new Map();
  for (const n of nodes) {
    const d = Math.min(3, depth(n));
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n);
  }

  const R = 15;
  const rowGap = Math.max(84, Math.min(150, height / (layers.size + 0.6)));
  const out = [];
  for (const [d, group] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const gap = Math.max(120, width / (group.length + 1));
    group.forEach((n, i) => {
      n.x = width / 2 + (i - (group.length - 1) / 2) * gap;
      n.y = R + 26 + d * rowGap;
      out.push(n);
    });
  }
  return out;
}

// ------------------------------------------------------------------- paint

function resize() {
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function fitView() {
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height || !nodes.length) return;
  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const k = Math.min(r.width / (w + 180), r.height / (h + 120), 1.4);
  view.k = k;
  view.x = r.width / 2 - ((minX + maxX) / 2) * k;
  view.y = r.height / 2 - ((minY + maxY) / 2) * k;
  fitted = true;
}

/**
 * Re-centres without touching the zoom. Docking the side panel narrows the
 * canvas, and refitting there would yank a view the user had panned or zoomed
 * into — the graph has to hold still while the layout moves around it.
 */
function recentre() {
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height || !nodes.length) return;
  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  view.x = r.width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * view.k;
  view.y = r.height / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * view.k;
}

const S = p => ({ x: p.x * view.k + view.x, y: p.y * view.k + view.y });

function draw() {
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return;
  ctx.clearRect(0, 0, r.width, r.height);

  const line = cssColor("var(--gray-7)");
  const dim = cssColor("var(--gray-11)");

  for (const e of edges) {
    const A = S(e.from), B = S(e.to);
    const midY = (A.y + B.y) / 2;
    const hot = selected && (e.from.id === selected.id || e.to.id === selected.id);
    ctx.strokeStyle = hot ? dim : line;
    ctx.lineWidth = hot ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    // orthogonal elbow: with one level of children an arc reads as noise
    ctx.lineTo(A.x, midY);
    ctx.lineTo(B.x, midY);
    ctx.lineTo(B.x, B.y);
    ctx.stroke();
  }

  for (const n of nodes) {
    const p = S(n);
    const isSel = selected?.id === n.id;
    const col = runtimeColor(n.runtime);

    if (n.live) {
      // Solid fill is reserved for a process that exists. Nothing that is merely
      // recent is allowed to look alive.
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 34);
      g.addColorStop(0, col.replace("rgb(", "rgba(").replace(")", ",0.28)"));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // subagent: no process of its own, shown hollow and dashed
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (isSel) {
      ctx.strokeStyle = cssColor("var(--gray-12)");
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.live ? 15 : 12, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = isSel ? cssColor("var(--gray-12)") : cssColor("var(--gray-11)");
    const t = n.title.length > 30 ? n.title.slice(0, 29) + "…" : n.title;
    ctx.fillText(t, p.x, p.y + 17);

    ctx.font = "9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = cssColor("var(--gray-9)");
    const sub = n.live ? `pid ${n.pid}${n.terminalId ? " · " + n.terminalId : ""}` : "subagent · not a process";
    ctx.fillText(sub, p.x, p.y + 31);
  }
}

function nodeAt(cx, cy) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const p = S(nodes[i]);
    const rad = nodes[i].live ? 15 : 12;
    if ((cx - p.x) ** 2 + (cy - p.y) ** 2 <= rad * rad) return nodes[i];
  }
  return null;
}

// ------------------------------------------------------------------- chrome

const ago = ms => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

function renderInfo() {
  const info = $("#graphinfo");
  info.replaceChildren();
  const chip = (text, cls) => {
    const c = document.createElement("span");
    c.className = "chip" + (cls ? " " + cls : "");
    c.textContent = text;
    info.appendChild(c);
  };
  const live = nodes.filter(n => n.live).length;
  chip(`${live} running`);
  if (nodes.length - live) chip(`${nodes.length - live} subagent`);
  if (data.subagents.length && !showSubagents) chip(`${data.subagents.length} hidden`, "warn");
}

function renderEmpty() {
  const box = $("#gempty");
  const none = nodes.length === 0;
  box.hidden = !none;
  if (!none) return;
  box.replaceChildren();
  const a = document.createElement("div");
  a.textContent = data.workspace ? `No agents running in ${data.workspace.name}` : "No workspace open";
  const b = document.createElement("div");
  b.style.fontSize = "11px";
  b.textContent = "Start opencode, codex or claude in a terminal of this workspace and it will show up here.";
  box.append(a, b);
}

/** The canvas is not reachable by keyboard; this list is. */
let listSig = null;

function renderList() {
  const list = $("#agentlist");
  // The poll runs every two seconds and this list is a focus target: rebuilding
  // it unconditionally would drop focus mid-interaction, so only touch the DOM
  // when the set of agents actually changed.
  const sig = nodes
    .map(n => `${n.id}|${n.title}|${n.runtime}|${n.live}|${n.pid}|${n.terminalId}|${!!(n.live && n.terminalId && openTerminal)}`)
    .join("\n");
  if (sig === listSig && list.childElementCount === (nodes.length ? nodes.length : 1)) return;
  listSig = sig;
  list.replaceChildren();

  if (!nodes.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "no running agents in this workspace";
    list.appendChild(li);
    return;
  }

  for (const n of nodes) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    // Activating an agent docks the shell it is running in beside this canvas —
    // that is the action worth taking, so it is what the control says it does.
    // Subagent sessions have no process and therefore no terminal to dock, so
    // those keep the read-only detail panel as their action.
    const canOpen = n.live && n.terminalId && openTerminal;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = n.title;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = n.live
      ? `${n.runtime} · pid ${n.pid}${n.terminalId ? ` · ${n.terminalId}` : ""}`
      : `${n.runtime} subagent · not a process`;
    btn.append(name, meta);

    if (canOpen) {
      const go = document.createElement("span");
      go.className = "go";
      go.textContent = "dock terminal →";
      btn.append(go);
      btn.title = `Dock terminal ${n.terminalId} beside the graph`;
    } else {
      btn.title = "Show details";
    }

    // The visible label is the short form above; this is what a screen reader
    // announces, and it has to carry the same facts the visual row does.
    btn.setAttribute(
      "aria-label",
      canOpen
        ? `${n.title}. ${n.runtime}, running, pid ${n.pid}, in terminal ${n.terminalId}. Dock that terminal beside the graph.`
        : n.live
          ? `${n.title}. ${n.runtime}, running, pid ${n.pid}. Show details.`
          : `${n.title}. ${n.runtime} subagent, not a running process. Show details.`,
    );
    btn.onclick = () => activate(n);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

/**
 * A live agent owns a shell, so selecting it docks that shell in the side panel
 * and this view stays on screen — the canvas is what tells you which agent you
 * are looking at, and switching the column away throws that away. A subagent
 * session has no process and therefore nothing to dock, so it keeps the
 * read-only detail panel as its only action.
 */
function activate(n) {
  if (!n) return showDetail(null);
  if (n.live && n.terminalId && openTerminal) {
    selected = n;
    draw();
    openTerminal(n.terminalId, n);
    return;
  }
  showDetail(n);
}

/** Selection only — the ring on the node, no panel and no terminal. */
function setSelected(n) {
  selected = n;
  draw();
}

function showDetail(n) {
  selected = n;
  // Tracked separately from `selected`: a docked terminal also holds a selection,
  // and the poll refreshes the panel from this. Refreshing it from `selected`
  // would re-open the detail panel over the user's terminal every two seconds.
  detailFor = n?.id ?? null;
  const panel = $("#detail");
  if (!n) { panel.hidden = true; draw(); return; }
  panel.hidden = false;
  $("#d-title").textContent = n.title;
  $("#d-runtime").textContent = n.live ? `${n.runtime} (running)` : `${n.runtime} subagent (no process of its own)`;
  $("#d-dir").textContent = data.workspace?.path ?? "—";
  $("#d-id").textContent = n.sessionId ?? "—";
  $("#d-upd").textContent = n.live
    ? `started ${new Date(n.startedAt).toLocaleTimeString()}`
    : `last write ${ago(n.updated)}`;

  const kids = edges.filter(e => e.from.id === n.id);
  $("#d-kids").textContent = kids.length ? kids.map(e => e.to.title).join("\n") : "none";

  const rel = $("#d-rel");
  rel.replaceChildren();
  if (n.parentId) {
    const b = document.createElement("b");
    b.textContent = nodes.find(p => p.id === n.parentId)?.title ?? n.parentId;
    rel.append("child of ", b);
  } else {
    rel.textContent = n.live ? "root agent" : "subagent session";
  }
  const m = document.createElement("div");
  m.style.marginTop = "6px";
  m.textContent = n.sessionMatch
    ? `session ${n.sessionMatch} (${n.sessionMatch === "explicit" ? "stated by process" : "matched by directory + start time"})`
    : "no session record linked yet";
  rel.appendChild(m);
  draw();
}

// --------------------------------------------------------------------- data

async function load() {
  if (!workspaceId) {
    data = { workspace: null, agents: [], subagents: [] };
    rebuild();
    return;
  }
  try {
    const res = await fetch(`/api/live?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    // Ignore a response for a workspace the user has already navigated away from.
    if (!workspaceId) return;
    const first = !data.agents.length && !data.subagents.length;
    data = next;
    rebuild();
    if (first) fitView();
    renderInfo();
    renderEmpty();
    if (detailFor) showDetail(nodes.find(n => n.id === detailFor) ?? null);
    onViewChange?.(
      `${next.workspace.name} · ${next.agents.length} running` +
      (showSubagents && next.subagents.length ? ` · ${next.subagents.length} subagent` : ""),
    );
  } catch (e) {
    const info = $("#graphinfo");
    info.replaceChildren();
    const c = document.createElement("span");
    c.className = "chip warn";
    c.textContent = `unavailable: ${e.message}`;
    info.appendChild(c);
  }
}

function rebuild() {
  const byId = new Map();
  nodes = data.agents.map(a => {
    const n = {
      id: a.sessionId ?? `pid:${a.pid}`,
      title: a.title || `${a.runtime} agent`,
      runtime: a.runtime,
      live: true,
      pid: a.pid,
      terminalId: a.terminalId,
      startedAt: a.startedAt,
      sessionId: a.sessionId,
      sessionMatch: a.matched,
      parentId: a.parentId,
      updated: a.startedAt,
    };
    byId.set(n.id, n);
    return n;
  });
  if (showSubagents) {
    for (const s of data.subagents) {
      if (byId.has(s.id)) continue;
      byId.set(s.id, {
        id: s.id,
        title: s.title || "subagent",
        runtime: s.runtime,
        live: false,
        parentId: s.parentId,
        updated: s.updated,
      });
      nodes.push(byId.get(s.id));
    }
  }
  // Only draw a link when both ends are on screen.
  edges = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) edges.push({ from: byId.get(n.parentId), to: n });
  }
  layoutTree(cv.clientWidth || 900, cv.clientHeight || 600);
  // No fitView() here. This runs on every poll, and refitting would yank the
  // canvas back to origin while the user is panning or zoomed into a node. The
  // first load fits once, and the ResizeObserver below handles window resizes.
  renderList();
  draw();
}

// -------------------------------------------------------------------- input

let drag = null;
cv.addEventListener("pointerdown", e => {
  cv.setPointerCapture(e.pointerId);
  drag = { x: e.offsetX, y: e.offsetY, moved: false, ox: view.x, oy: view.y };
});
cv.addEventListener("pointermove", e => {
  if (!drag) return;
  const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  view.x = drag.ox + dx;
  view.y = drag.oy + dy;
  draw();
});
cv.addEventListener("pointerup", e => {
  const wasDrag = drag?.moved;
  drag = null;
  if (wasDrag) return;
  activate(nodeAt(e.offsetX, e.offsetY));
});
cv.addEventListener("wheel", e => {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const next = Math.max(0.3, Math.min(2.5, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
  view.x = e.offsetX - ((e.offsetX - view.x) / view.k) * next;
  view.y = e.offsetY - ((e.offsetY - view.y) / view.k) * next;
  view.k = next;
  draw();
}, { passive: false });

// Docking the side panel hides the agent list, which is the only control the
// canvas has to fall back on. These keys keep every node reachable without a
// pointer, and announce the selection through the canvas label.
cv.addEventListener("keydown", e => {
  if (!nodes.length) return;
  const i = selected ? nodes.findIndex(n => n.id === selected.id) : -1;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    e.preventDefault();
    setSelected(nodes[i + 1] ?? nodes[0]);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    setSelected(nodes[i <= 0 ? nodes.length - 1 : i - 1]);
  } else if (e.key === "Home") {
    e.preventDefault();
    setSelected(nodes[0]);
  } else if (e.key === "End") {
    e.preventDefault();
    setSelected(nodes[nodes.length - 1]);
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    activate(selected);
  }
});
cv.addEventListener("focus", () => { if (!selected && nodes.length) setSelected(nodes[0]); });

$("#detailx").onclick = () => showDetail(null);
document.addEventListener("keydown", e => { if (e.key === "Escape" && selected) showDetail(null); });

$("#subagents").onchange = e => {
  showSubagents = e.target.checked;
  rebuild();
  renderInfo();
  renderEmpty();
  if (detailFor) showDetail(nodes.find(n => n.id === detailFor) ?? null);
};

// Docking and resizing the side panel change the canvas width. Refitting there
// would reset a view the user had panned or zoomed, so the centre is held instead
// and only the very first layout fits.
new ResizeObserver(() => {
  if (nodes.length) {
    layoutTree(cv.clientWidth, cv.clientHeight);
    if (fitted) recentre();
    else fitView();
  }
  resize();
}).observe(cv.parentElement);

// ------------------------------------------------------------------- exports

export function showGraph(onStatus, wsId, onOpenTerm) {
  onViewChange = onStatus;
  openTerminal = onOpenTerm;
  workspaceId = wsId;
  selected = null;
  detailFor = null;
  $("#detail").hidden = true;
  load();
}

export function hideGraph() {
  selected = null;
  detailFor = null;
  $("#detail").hidden = true;
}

/** Called when the rail selection changes so the canvas follows the workspace. */
export function setWorkspace(wsId) {
  if (wsId === workspaceId) return;
  workspaceId = wsId;
  if ($("#graphview").classList.contains("on")) load();
}

/** Selection ring only, driven from app.js when the side panel docks or closes. */
export { setSelected };

/**
 * Re-measures immediately, without waiting for the ResizeObserver.
 *
 * Docking or closing the side panel changes the canvas width. Left to the
 * observer alone there is a frame where the canvas has already resized but the
 * view transform and the paint still describe the old one, so a node is drawn
 * where it no longer is and a click in that frame hits nothing.
 */
export function relayout() {
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return;
  if (nodes.length) {
    layoutTree(cv.clientWidth, cv.clientHeight);
    if (fitted) recentre();
    else fitView();
  }
  resize();
}

// Two seconds: a process is a cheap thing to check, and the whole point of this
// view is that a node means "right now". Only while visible.
setInterval(() => {
  if ($("#graphview").classList.contains("on")) load();
}, 2000);
