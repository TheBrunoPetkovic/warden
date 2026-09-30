import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const css = variable => getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
const stateVar = { working: "--green-9", "needs-input": "--red-9", "complete-unread": "--blue-9", "complete-read": "--gray-8", idle: "--yellow-9", failed: "--orange-9" };
const colorFor = state => css(stateVar[state] ?? "--gray-8");
const stateLabel = state => ({ working: "WORKING", "needs-input": "INPUT NEEDED", "complete-unread": "DONE · UNREAD", "complete-read": "DONE · READ", idle: "IDLE", failed: "FAILED" })[state] ?? "IDLE";
const ago = ms => {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;
};

function arrange(raw, width, height) {
  const byId = new Map(raw.map(node => [node.id, node]));
  const depths = new Map();
  const depth = node => {
    if (depths.has(node.id)) return depths.get(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : null;
    const value = parent ? depth(parent) + 1 : 0;
    depths.set(node.id, value);
    return value;
  };
  const layers = new Map();
  raw.forEach(node => {
    const layer = Math.min(3, depth(node));
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  });
  const gapX = Math.max(220, Math.min(280, width / (layers.size + 0.8)));
  for (const [layer, group] of layers) {
    const gapY = Math.max(82, Math.min(126, height / (group.length + 1)));
    group.forEach((node, index) => Object.assign(node, {
      x: 112 + layer * gapX,
      y: height / 2 + (index - (group.length - 1) / 2) * gapY,
      width: 172,
      height: 54,
    }));
  }
  return raw;
}

const curvePoint = (from, to, t) => {
  const middle = (from.x + to.x) / 2;
  const u = 1 - t;
  return {
    x: u ** 3 * from.x + 3 * u ** 2 * t * middle + 3 * u * t ** 2 * middle + t ** 3 * to.x,
    y: u ** 3 * from.y + 3 * u ** 2 * t * from.y + 3 * u * t ** 2 * to.y + t ** 3 * to.y,
  };
};

function Canvas({ nodes, edges, pulses, selected, onActivate, onSelect }) {
  const ref = useRef(null);
  const view = useRef({ x: 0, y: 0, k: 1, fitted: false });
  const pointer = useRef(null);
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const screen = point => ({ x: point.x * view.current.k + view.current.x, y: point.y * view.current.k + view.current.y });
  const anchor = (node, right) => ({ ...screen(node), x: screen(node).x + (right ? node.width / 2 : -node.width / 2) });

  const paint = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(bounds.width * ratio) || canvas.height !== Math.round(bounds.height * ratio)) {
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
    }
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    const now = performance.now();
    const bright = css("--gray-12");
    for (const edge of edges) {
      const from = anchor(edge.from, true), to = anchor(edge.to, false);
      const hot = selected?.id === edge.from.id || selected?.id === edge.to.id;
      context.strokeStyle = hot ? bright : css("--gray-7");
      context.lineWidth = hot ? 1.6 : 1;
      context.beginPath(); context.moveTo(from.x, from.y);
      context.bezierCurveTo((from.x + to.x) / 2, from.y, (from.x + to.x) / 2, to.y, to.x, to.y);
      context.stroke();
    }
    for (const pulse of reducedMotion ? [] : pulses) {
      const age = now - pulse.at;
      if (age < 0 || age > 1200) continue;
      const edge = edges.find(item => item.from.id === pulse.from && item.to.id === pulse.to);
      if (!edge) continue;
      const source = pulse.direction === "down" ? edge.from : edge.to;
      const destination = pulse.direction === "down" ? edge.to : edge.from;
      const point = curvePoint(anchor(source, pulse.direction === "down"), anchor(destination, pulse.direction !== "down"), Math.min(1, age / 900));
      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, 14);
      glow.addColorStop(0, colorFor(destination.visualState)); glow.addColorStop(1, "transparent");
      context.globalAlpha = Math.max(0, 1 - age / 1200);
      context.fillStyle = glow; context.beginPath(); context.arc(point.x, point.y, 14, 0, Math.PI * 2); context.fill(); context.globalAlpha = 1;
    }
    for (const node of nodes) {
      const point = screen(node), color = colorFor(node.visualState), picked = selected?.id === node.id;
      const working = node.visualState === "working";
      if (working) {
        const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, 68);
        glow.addColorStop(0, color); glow.addColorStop(1, "transparent");
        context.globalAlpha = node.live ? 0.13 : 0.2;
        context.fillStyle = glow; context.beginPath(); context.arc(point.x, point.y, 68, 0, Math.PI * 2); context.fill(); context.globalAlpha = 1;
      }
      context.fillStyle = css("--surface");
      context.strokeStyle = color;
      context.lineWidth = picked ? 1.75 : 1.15;
      context.beginPath(); context.roundRect(point.x - node.width / 2, point.y - node.height / 2, node.width, node.height, 8); context.fill(); context.stroke();
      context.fillStyle = color; context.beginPath(); context.arc(point.x - node.width / 2 + 14, point.y - 10, 4, 0, Math.PI * 2); context.fill();
      context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace"; context.textAlign = "left"; context.textBaseline = "middle";
      context.fillStyle = picked ? bright : css("--gray-11");
      context.fillText(node.title.length > 21 ? `${node.title.slice(0, 20)}…` : node.title, point.x - node.width / 2 + 24, point.y - 10);
      context.font = "9.5px ui-monospace, SFMono-Regular, Menlo, monospace"; context.fillStyle = css("--gray-9");
      context.fillText(`${stateLabel(node.visualState)} · ${node.runtime}`, point.x - node.width / 2 + 24, point.y + 10);
      if (working) {
        const phase = reducedMotion ? 2 : Math.floor(now / 180) % 3;
        for (let index = 0; index < 3; index++) {
          context.globalAlpha = index <= phase ? 1 : 0.2; context.fillStyle = color;
          context.beginPath(); context.arc(point.x + node.width / 2 - 28 + index * 7, point.y + 10, 1.5, 0, Math.PI * 2); context.fill();
        }
        context.globalAlpha = 1;
      }
    }
  }, [edges, nodes, pulses, reducedMotion, selected]);

  useEffect(() => {
    let frame;
    const animate = () => {
      paint();
      if (pulses.some(pulse => performance.now() - pulse.at < 1200)) frame = requestAnimationFrame(animate);
    };
    if (!reducedMotion && pulses.some(pulse => performance.now() - pulse.at < 1200)) frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [paint, pulses, reducedMotion]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const fit = () => {
      const bounds = canvas.getBoundingClientRect();
      if (!nodes.length || !bounds.width || !bounds.height) return;
      if (!view.current.fitted) {
        const xs = nodes.map(node => node.x), ys = nodes.map(node => node.y);
        const k = Math.min(bounds.width / (Math.max(...xs) - Math.min(...xs) + 250), bounds.height / (Math.max(...ys) - Math.min(...ys) + 150), 1.35);
        view.current = { x: bounds.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * k, y: bounds.height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * k, k, fitted: true };
      }
      paint();
    };
    const observer = new ResizeObserver(fit); observer.observe(canvas.parentElement); fit();
    return () => observer.disconnect();
  }, [nodes, paint]);
  useEffect(() => paint(), [paint]);

  const nodeAt = event => {
    const bounds = ref.current.getBoundingClientRect(); const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    return [...nodes].reverse().find(node => {
      const point = screen(node);
      return x >= point.x - node.width / 2 && x <= point.x + node.width / 2 && y >= point.y - node.height / 2 && y <= point.y + node.height / 2;
    });
  };
  return <canvas ref={ref} id="graph" tabIndex="0" role="application" aria-label="Live agent activity graph"
    onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); pointer.current = { x: event.clientX, y: event.clientY, ox: view.current.x, oy: view.current.y, moved: false }; }}
    onPointerMove={event => { if (!pointer.current) return; const dx = event.clientX - pointer.current.x, dy = event.clientY - pointer.current.y; if (Math.abs(dx) + Math.abs(dy) > 3) pointer.current.moved = true; view.current.x = pointer.current.ox + dx; view.current.y = pointer.current.oy + dy; paint(); }}
    onPointerUp={event => { const drag = pointer.current; pointer.current = null; if (drag?.moved) return; const node = nodeAt(event); if (!node) return onSelect(null); onSelect(node); onActivate(node); }}
    onWheel={event => { event.preventDefault(); const bounds = ref.current.getBoundingClientRect(); const x = event.clientX - bounds.left, y = event.clientY - bounds.top; const next = Math.max(0.3, Math.min(2.5, view.current.k * (event.deltaY < 0 ? 1.12 : 0.89))); view.current.x = x - ((x - view.current.x) / view.current.k) * next; view.current.y = y - ((y - view.current.y) / view.current.k) * next; view.current.k = next; paint(); }}
  />;
}

export function AgentGraph({ workspaceId, onOpenTerminal, onOpenSubagent, sidePanel }) {
  const [data, setData] = useState({ workspace: null, agents: [], subagents: [] });
  const [showSubagents, setShowSubagents] = useState(true);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [pulses, setPulses] = useState([]);
  const [seen, setSeen] = useState(() => new Set(JSON.parse(localStorage.getItem("warden.seen-agent-completions") ?? "[]")));
  const previous = useRef(new Map());

  const markSeen = useCallback(node => {
    if (node.state !== "complete" || seen.has(node.id)) return;
    setSeen(current => {
      const next = new Set(current); next.add(node.id);
      localStorage.setItem("warden.seen-agent-completions", JSON.stringify([...next]));
      return next;
    });
  }, [seen]);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/live?workspaceId=${encodeURIComponent(workspaceId)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json();
        if (!cancelled) { setData(next); setError(""); }
      } catch (cause) { if (!cancelled) setError(cause.message); }
    };
    void load(); const poll = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [workspaceId]);

  const nodes = useMemo(() => {
    const decorate = node => ({ ...node, title: node.title || `${node.runtime} agent`, visualState: node.state === "complete" ? (seen.has(node.id) ? "complete-read" : "complete-unread") : (node.state ?? (node.live ? "working" : "idle")) });
    const roots = data.agents.map(agent => decorate({ ...agent, id: agent.sessionId ?? `pid:${agent.pid}`, live: true, sessionId: agent.sessionId }));
    const ids = new Set(roots.map(node => node.id));
    if (showSubagents) data.subagents.forEach(session => { if (!ids.has(session.id)) roots.push(decorate({ ...session, id: session.id, sessionId: session.id, live: false })); });
    return arrange(roots, 1100, 680);
  }, [data, seen, showSubagents]);
  const edges = useMemo(() => {
    const ids = new Map(nodes.map(node => [node.id, node]));
    return nodes.filter(node => node.parentId && ids.has(node.parentId)).map(node => ({ from: ids.get(node.parentId), to: node }));
  }, [nodes]);

  useEffect(() => {
    const next = new Map(nodes.map(node => [node.id, node]));
    const started = [];
    if (previous.current.size) {
      for (const node of nodes) {
        const before = previous.current.get(node.id);
        if (!node.parentId) continue;
        if (!before) started.push({ from: node.parentId, to: node.id, direction: "down", at: performance.now() });
        else if (node.updated && node.updated !== before.updated) started.push({ from: node.parentId, to: node.id, direction: "up", at: performance.now() });
      }
    }
    previous.current = next;
    if (started.length) setPulses(current => [...current.filter(pulse => performance.now() - pulse.at < 1200), ...started]);
  }, [nodes]);

  const activate = node => {
    markSeen(node);
    if (node.live && node.terminalId) { setDetail(null); onOpenTerminal(node); return; }
    if (!node.live && node.runtime === "opencode" && node.sessionId) { setDetail(null); onOpenSubagent(node); return; }
    setDetail(node);
  };
  const live = nodes.filter(node => node.live).length;
  return <div id="graphmain"><div id="graphwrap"><Canvas nodes={nodes} edges={edges} pulses={pulses} selected={selected} onSelect={setSelected} onActivate={activate}/><div id="graphbar"><label className="toggle"><input type="checkbox" checked={showSubagents} onChange={event => setShowSubagents(event.target.checked)}/> show subagent sessions</label><span className="win-note">branches flow from parent to child, left to right</span></div><div id="graphinfo"><span className="chip">{live} running</span>{nodes.length - live > 0 && <span className="chip">{nodes.length - live} subagent</span>}{error && <span className="chip warn">unavailable: {error}</span>}</div>{!nodes.length && <div id="gempty"><div>{data.workspace ? `No agents running in ${data.workspace.name}` : "No workspace open"}</div><div>Agents started in this workspace will appear here.</div></div>}<div id="graphhint">drag to pan, scroll to zoom · click a node to open its chat</div>{detail && <div id="detail"><button className="x" onClick={() => setDetail(null)} aria-label="Close details">×</button><h2>{detail.title}</h2><div className="row"><span className="k">state</span><span className="v">{stateLabel(detail.visualState)}</span></div><div className="row"><span className="k">runtime</span><span className="v">{detail.live ? `${detail.runtime} (running)` : `${detail.runtime} subagent`}</span></div><div className="row"><span className="k">directory</span><span className="v">{data.workspace?.path ?? "—"}</span></div><div className="row"><span className="k">session</span><span className="v">{detail.sessionId ?? "—"}</span></div><div className="row"><span className="k">updated</span><span className="v">{detail.live ? `started ${new Date(detail.startedAt).toLocaleTimeString()}` : `last write ${ago(detail.updated)}`}</span></div><div className="rel">{detail.parentId ? `child of ${nodes.find(node => node.id === detail.parentId)?.title ?? detail.parentId}` : detail.live ? "root agent" : "subagent session"}</div></div>}</div>{sidePanel ?? <ul id="agentlist" aria-label="Running agents">{nodes.length ? nodes.map(node => <li key={node.id}><button type="button" onClick={() => { setSelected(node); activate(node); }} title={node.live && node.terminalId ? `Open chat for ${node.terminalId}` : !node.live && node.runtime === "opencode" ? "Watch this subagent's activity" : "Show details"}><span className="name">{node.title}</span><span className="meta">{node.runtime} · {stateLabel(node.visualState).toLowerCase()}</span>{(node.live && node.terminalId) || (!node.live && node.runtime === "opencode") ? <span className="go">{node.live ? "open chat →" : "watch activity →"}</span> : null}</button></li>) : <li className="empty">no running agents in this workspace</li>}</ul>}</div>;
}
