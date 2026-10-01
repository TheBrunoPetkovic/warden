import { useCallback, useEffect, useRef, useState } from "react";
import { AgentGraph } from "./AgentGraph.jsx";
import { TerminalPane } from "./TerminalPane.jsx";

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
};

function WorkspaceRail({ workspaces, activeId, onOpen, onCreate, onDelete, onNewAgent }) {
  const [name, setName] = useState("");
  const submit = async event => {
    event.preventDefault();
    if (!name.trim()) return;
    await onCreate(name.trim());
    setName("");
  };
  const active = workspaces.find(workspace => workspace.id === activeId);
  return <nav id="rail"><div className="rail-head">Workspaces <span className="count">{workspaces.length || ""}</span></div><div id="wslist">{workspaces.map(workspace => <div key={workspace.id} className={`ws${workspace.id === activeId ? " sel" : ""}${workspace.missing ? " gone" : ""}`} role="button" tabIndex="0" onClick={() => onOpen(workspace)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(workspace); } }}><div className="body"><div className="name">{workspace.name}</div><div className="path">{workspace.path}</div></div><button className="kill" onClick={event => { event.stopPropagation(); onDelete(workspace); }} title={workspace.missing ? `Forget ${workspace.name}` : `Delete ${workspace.name}`} aria-label={`Delete ${workspace.name}`}>×</button></div>)}</div><button id="newagent" type="button" onClick={onNewAgent} disabled={!active || active.missing} title={active ? `Start an OpenCode agent in ${active.name}` : "Select a workspace first"}>+ New agent</button><form id="newws" onSubmit={submit}><input value={name} onChange={event => setName(event.target.value)} placeholder="new workspace" autoComplete="off" spellCheck="false" aria-label="New workspace name"/><button className="icon-btn" type="submit" title="Create workspace" aria-label="Create workspace">+</button></form></nav>;
}

function ResizeGrip({ width, setWidth }) {
  const [resizing, setResizing] = useState(false);
  const drag = useRef(null);
  const clamp = value => Math.max(240, Math.min(value, Math.round(window.innerWidth * 0.7)));
  const startResize = event => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { start: event.clientX, width };
    setResizing(true);
  };
  const resize = event => {
    if (!drag.current) return;
    setWidth(clamp(drag.current.width - (event.clientX - drag.current.start)));
  };
  const stopResize = () => { drag.current = null; setResizing(false); };
  return <div id="sidegrip" className={resizing ? "drag" : ""} role="separator" aria-orientation="vertical" tabIndex="0" aria-label="Resize terminal panel" aria-valuemin="240" aria-valuenow={width} onPointerDown={startResize} onPointerMove={resize} onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={event => { const delta = event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0; if (delta) { event.preventDefault(); setWidth(clamp(width + delta)); } }}/>;
}

function SideTerminal({ node, terminal, width, setWidth, onClose, onExit, onToast }) {
  return <div id="sidepanel" style={{ "--side-w": `${width}px` }}><ResizeGrip width={width} setWidth={setWidth}/><div id="sidehead" tabIndex="-1"><span className="t">{node?.title ?? terminal.name ?? terminal.id}</span><span className="m">{node?.live ? `${node.runtime} · pid ${node.pid}` : `${node?.runtime ?? "terminal"} subagent · ${terminal.id}`}</span><span className="spacer"/><button className="icon-btn" onClick={onClose} title="Close terminal panel" aria-label="Close terminal panel">×</button></div><div id="sideterm"><TerminalPane terminal={terminal} startupInput={terminal.startupInput} onExit={onExit} onError={onToast}/></div></div>;
}

function SubagentActivity({ node, width, setWidth, onClose, onToast }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api(`/api/sessions/${encodeURIComponent(node.sessionId)}/messages`);
        if (!cancelled) { setEntries(next); setLoading(false); }
      } catch (error) { if (!cancelled) { setLoading(false); onToast(`subagent activity: ${error.message}`); } }
    };
    void load();
    const poll = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [node.sessionId, onToast]);
  return <div id="sidepanel" style={{ "--side-w": `${width}px` }}><ResizeGrip width={width} setWidth={setWidth}/><div id="sidehead" tabIndex="-1"><span className="t">{node.title}</span><span className="m">read-only subagent activity</span><span className="spacer"/><button className="icon-btn" onClick={onClose} title="Close activity panel" aria-label="Close activity panel">×</button></div><div id="subagent-activity" role="log" aria-live="polite">{loading ? <div className="activity-empty">loading subagent activity…</div> : entries.length ? entries.map((entry, index) => <div className={`activity-entry ${entry.kind}`} key={`${index}-${entry.kind}`}>{entry.kind === "text" ? entry.text : entry.kind === "tool" ? <><span className="activity-tool">{entry.tool ?? "tool"}</span><span>{entry.status ?? "working"}</span>{entry.output && <pre>{entry.output}</pre>}</> : entry.kind}</div>) : <div className="activity-empty">No messages yet. The subagent will appear here while it works.</div>}</div><div className="activity-note">Read-only. Ask the parent agent if you want to redirect or stop this subagent.</div></div>;
}

export function App() {
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWs, setActiveWs] = useState(null);
  const [termsByWorkspace, setTermsByWorkspace] = useState({});
  const [side, setSide] = useState(null);
  const [sideWidth, setSideWidth] = useState(420);
  const [toast, setToast] = useState("");
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeWs);
  const terminals = termsByWorkspace[activeWs] ?? [];
  const notify = useCallback(message => {
    setToast(message);
    window.setTimeout(() => setToast(current => current === message ? "" : current), 4000);
  }, []);
  const syncTerminals = useCallback(async workspaceId => {
    const all = await api("/api/terminals");
    const terms = all.filter(terminal => terminal.workspaceId === workspaceId).map(terminal => ({ id: terminal.id, workspaceId: terminal.workspaceId, dead: !terminal.alive }));
    setTermsByWorkspace(current => ({ ...current, [workspaceId]: terms }));
    return terms;
  }, []);
  const loadWorkspaces = useCallback(async () => {
    const all = await api("/api/workspaces");
    setWorkspaces(all);
    return all;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const all = await loadWorkspaces();
        const first = all.find(workspace => !workspace.missing);
        if (!first) return;
        setActiveWs(first.id);
        await syncTerminals(first.id);
      } catch (error) { notify(error.message); }
    })();
  }, [loadWorkspaces, notify, syncTerminals]);
  const openWorkspace = useCallback(async workspace => {
    if (workspace.missing) return notify(`"${workspace.name}" — its directory no longer exists.`);
    if (workspace.id === activeWs) return;
    try {
      setActiveWs(workspace.id);
      setSide(null);
      await syncTerminals(workspace.id);
    } catch (error) { notify(error.message); }
  }, [activeWs, notify, syncTerminals]);
  const createWorkspace = async name => {
    try { const workspace = await api("/api/workspaces", { method: "POST", body: { name } }); await loadWorkspaces(); await openWorkspace(workspace); } catch (error) { notify(error.message); }
  };
  const createAgent = useCallback(async () => {
    if (!activeWs || !activeWorkspace || activeWorkspace.missing) return;
    try {
      const terminal = await api(`/api/workspaces/${encodeURIComponent(activeWs)}/agents`, { method: "POST" });
      const next = { ...terminal, dead: false };
      setTermsByWorkspace(current => ({ ...current, [activeWs]: [...(current[activeWs] ?? []), next] }));
      setSide({ kind: "terminal", termId: next.id, node: { title: "New OpenCode agent", runtime: "opencode", live: true, terminalId: next.id, pid: next.pid } });
    } catch (error) { notify(`new agent: ${error.message}`); }
  }, [activeWs, activeWorkspace, notify]);
  const deleteWorkspace = async workspace => {
    if (!workspace.missing && !window.confirm(`Delete workspace "${workspace.name}"? Its directory and running terminals are removed.`)) return;
    try {
      await api(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
      if (workspace.id === activeWs) { setActiveWs(null); setSide(null); }
      await loadWorkspaces();
    } catch (error) { notify(error.message); }
  };
  const markExited = useCallback(id => {
    setTermsByWorkspace(current => ({
      ...current,
      [activeWs]: (current[activeWs] ?? []).map(terminal => terminal.id === id ? { ...terminal, dead: true } : terminal),
    }));
  }, [activeWs]);
  const openRootTerminal = node => {
    const terminal = terminals.find(item => item.id === node.terminalId);
    if (!terminal) return notify(`terminal ${node.terminalId} is no longer in this workspace`);
    if (terminal.dead) return notify(`terminal ${node.terminalId} has exited`);
    setSide({ kind: "terminal", termId: terminal.id, node });
  };
  const openSubagent = node => { setSide({ kind: "subagent", node }); };
  const sideTerminal = side?.kind === "terminal" ? terminals.find(terminal => terminal.id === side.termId) : null;
  const sidePanel = side?.kind === "subagent"
    ? <SubagentActivity node={side.node} width={sideWidth} setWidth={setSideWidth} onClose={() => setSide(null)} onToast={notify}/>
    : sideTerminal ? <SideTerminal node={side.node} terminal={sideTerminal} width={sideWidth} setWidth={setSideWidth} onClose={() => setSide(null)} onExit={markExited} onToast={notify}/>
      : null;
  return <><div id="windowbar" aria-hidden="true"/><main><WorkspaceRail workspaces={workspaces} activeId={activeWs} onOpen={openWorkspace} onCreate={createWorkspace} onDelete={deleteWorkspace} onNewAgent={createAgent}/><section id="col"><div className="view on"><AgentGraph workspaceId={activeWs} onOpenTerminal={openRootTerminal} onOpenSubagent={openSubagent} sidePanel={sidePanel}/></div></section></main><div id="toast" className={toast ? "show" : ""} role="status" aria-live="polite">{toast}</div></>;
}
