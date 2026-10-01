import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Settings, Trash2, X } from "lucide-react";
import { AgentGraph } from "./AgentGraph.jsx";
import { TerminalPane } from "./TerminalPane.jsx";
import { Button } from "./components/ui/button.jsx";
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogTitle } from "./components/ui/dialog.jsx";
import { Input } from "./components/ui/input.jsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip.jsx";

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

const SCHEMES = [
  ["tokyo-night", "Tokyo Night", "#7aa2f7"],
  ["catppuccin", "Catppuccin", "#89b4fa"],
  ["dracula", "Dracula", "#bd93f9"],
  ["nord", "Nord", "#88c0d0"],
  ["gruvbox", "Gruvbox", "#fabd2f"],
  ["one-dark", "One Dark", "#61afef"],
  ["solarized", "Solarized Dark", "#2aa198"],
  ["monokai", "Monokai", "#a6e22e"],
  ["rose-pine", "Rosé Pine", "#c4a7e7"],
  ["kanagawa", "Kanagawa", "#7e9cd8"],
  ["everforest", "Everforest", "#a7c080"],
  ["night-owl", "Night Owl", "#82aaff"],
  ["ayu", "Ayu Mirage", "#ffcc66"],
  ["material", "Material", "#80cbc4"],
  ["cyberpunk", "Cyberpunk", "#f92aad"],
];

const readAppearance = () => {
  try { return { theme: "system", scheme: "tokyo-night", ...JSON.parse(localStorage.getItem("warden.appearance") ?? "{}") }; }
  catch { return { theme: "system", scheme: "tokyo-night" }; }
};

function SettingsModal({ appearance, onChange, onClose }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogOverlay id="settings-backdrop"/><DialogContent id="settings-modal"><aside id="settings-nav"><div className="settings-nav-label">Settings</div><Button className="settings-nav-item active" type="button">Appearance</Button></aside><div id="settings-content"><header className="settings-header"><DialogTitle id="settings-title">Appearance</DialogTitle><DialogClose asChild><Button className="icon-btn" type="button" aria-label="Close settings"><X aria-hidden="true"/></Button></DialogClose></header><section className="settings-group"><div className="settings-group-title">Theme</div><div className="theme-options">{[["dark", "Dark"], ["light", "Light"], ["system", "System"]].map(([id, label]) => <Button key={id} type="button" className={`theme-option ${appearance.theme === id ? "selected" : ""}`} onClick={() => onChange({ ...appearance, theme: id })}><span className={`theme-preview ${id}`}/><span>{label}</span></Button>)}</div></section><section className="settings-group"><div className="settings-group-title">Color Scheme</div><div className="scheme-options">{SCHEMES.map(([id, label, color]) => <Button key={id} type="button" className={`scheme-option ${appearance.scheme === id ? "selected" : ""}`} onClick={() => onChange({ ...appearance, scheme: id })}><i style={{ "--swatch": color }}/><span>{label}</span>{appearance.scheme === id && <b>✓</b>}</Button>)}</div></section></div></DialogContent></Dialog>;
}

function WorkspaceRail({ workspaces, activeId, onOpen, onCreate, onDelete }) {
  const [name, setName] = useState("");
  const submit = async event => {
    event.preventDefault();
    if (!name.trim()) return;
    await onCreate(name.trim());
    setName("");
  };
  return <nav id="rail"><div className="rail-head">Workspaces <span className="count">{workspaces.length || ""}</span></div><div id="wslist">{workspaces.map(workspace => <div key={workspace.id} className={`ws${workspace.id === activeId ? " sel" : ""}${workspace.missing ? " gone" : ""}`} role="button" tabIndex="0" onClick={() => onOpen(workspace)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(workspace); } }}><div className="body"><div className="name">{workspace.name}</div><div className="path">{workspace.path}</div></div><Button className="kill" type="button" onClick={event => { event.stopPropagation(); onDelete(workspace); }} title={workspace.missing ? `Forget ${workspace.name}` : `Delete ${workspace.name}`} aria-label={`Delete ${workspace.name}`}><Trash2 aria-hidden="true"/></Button></div>)}</div><form id="newws" onSubmit={submit}><Input value={name} onChange={event => setName(event.target.value)} placeholder="new workspace" autoComplete="off" spellCheck="false" aria-label="New workspace name"/><Button className="icon-btn" type="submit" title="Create workspace" aria-label="Create workspace"><Plus aria-hidden="true"/></Button></form></nav>;
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

function RailResizeGrip({ width, setWidth }) {
  const [resizing, setResizing] = useState(false);
  const drag = useRef(null);
  const clamp = value => Math.max(180, Math.min(value, Math.round(window.innerWidth * 0.45)));
  const startResize = event => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { start: event.clientX, width };
    setResizing(true);
  };
  const resize = event => {
    if (!drag.current) return;
    setWidth(clamp(drag.current.width + event.clientX - drag.current.start));
  };
  const stopResize = () => { drag.current = null; setResizing(false); };
  return <div id="railgrip" className={resizing ? "drag" : ""} role="separator" aria-orientation="vertical" tabIndex="0" aria-label="Resize workspace sidebar" aria-valuemin="180" aria-valuenow={width} onPointerDown={startResize} onPointerMove={resize} onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={event => { const delta = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0; if (delta) { event.preventDefault(); setWidth(clamp(width + delta)); } }}/>;
}

function SideTerminal({ node, terminal, width, setWidth, onClose, onExit, onToast, appearance }) {
  const meta = node?.workspaceTerminal ? `terminal · ${terminal.id}` : node?.live ? `${node.runtime} · pid ${node.pid}` : `${node?.runtime ?? "terminal"} subagent · ${terminal.id}`;
  return <div id="sidepanel" style={{ "--side-w": `${width}px` }}><ResizeGrip width={width} setWidth={setWidth}/><div id="sidehead" tabIndex="-1"><span className="t">{node?.title ?? terminal.name ?? terminal.id}</span><span className="m">{meta}</span><span className="spacer"/><Button className="icon-btn" type="button" onClick={onClose} title="Close terminal panel" aria-label="Close terminal panel"><X aria-hidden="true"/></Button></div><div id="sideterm"><TerminalPane terminal={terminal} startupInput={terminal.startupInput} onExit={onExit} onError={onToast} appearance={appearance}/></div></div>;
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
  return <div id="sidepanel" style={{ "--side-w": `${width}px` }}><ResizeGrip width={width} setWidth={setWidth}/><div id="sidehead" tabIndex="-1"><span className="t">{node.title}</span><span className="m">read-only subagent activity</span><span className="spacer"/><Button className="icon-btn" type="button" onClick={onClose} title="Close activity panel" aria-label="Close activity panel"><X aria-hidden="true"/></Button></div><div id="subagent-activity" role="log" aria-live="polite">{loading ? <div className="activity-empty">loading subagent activity…</div> : entries.length ? entries.map((entry, index) => <div className={`activity-entry ${entry.kind}`} key={`${index}-${entry.kind}`}>{entry.kind === "text" ? entry.text : entry.kind === "tool" ? <><span className="activity-tool">{entry.tool ?? "tool"}</span><span>{entry.status ?? "working"}</span>{entry.output && <pre>{entry.output}</pre>}</> : entry.kind}</div>) : <div className="activity-empty">No messages yet. The subagent will appear here while it works.</div>}</div><div className="activity-note">Read-only. Ask the parent agent if you want to redirect or stop this subagent.</div></div>;
}

export function App() {
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWs, setActiveWs] = useState(null);
  const [termsByWorkspace, setTermsByWorkspace] = useState({});
  const [side, setSide] = useState(null);
  const [sideWidth, setSideWidth] = useState(420);
  const [railWidth, setRailWidth] = useState(() => {
    const stored = Number(localStorage.getItem("warden.workspace-sidebar-width"));
    return Number.isFinite(stored) ? Math.max(180, Math.min(stored, 500)) : 236;
  });
  const [toast, setToast] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearance, setAppearance] = useState(readAppearance);
  const terminals = termsByWorkspace[activeWs] ?? [];
  const notify = useCallback(message => {
    setToast(message);
    window.setTimeout(() => setToast(current => current === message ? "" : current), 4000);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = appearance.theme === "system" ? (media.matches ? "dark" : "light") : appearance.theme;
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.scheme = appearance.scheme;
      document.documentElement.classList.toggle("dark", theme === "dark");
    };
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem("warden.appearance", JSON.stringify(appearance));
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
  useEffect(() => { localStorage.setItem("warden.workspace-sidebar-width", String(railWidth)); }, [railWidth]);
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
    try {
      setActiveWs(workspace.id);
      const existing = (await syncTerminals(workspace.id)).find(terminal => !terminal.dead);
      if (existing) {
        setSide({ kind: "terminal", termId: existing.id, node: { title: `${workspace.name} terminal`, workspaceTerminal: true } });
        return;
      }
      const terminal = await api("/api/terminals", { method: "POST", body: { workspaceId: workspace.id } });
      const next = { ...terminal, dead: false };
      setTermsByWorkspace(current => ({ ...current, [workspace.id]: [...(current[workspace.id] ?? []), next] }));
      setSide({ kind: "terminal", termId: next.id, node: { title: `${workspace.name} terminal`, workspaceTerminal: true } });
    } catch (error) { notify(error.message); }
  }, [notify, syncTerminals]);
  const createWorkspace = async name => {
    try { const workspace = await api("/api/workspaces", { method: "POST", body: { name } }); await loadWorkspaces(); await openWorkspace(workspace); } catch (error) { notify(error.message); }
  };
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
    : sideTerminal ? <SideTerminal node={side.node} terminal={sideTerminal} width={sideWidth} setWidth={setSideWidth} onClose={() => setSide(null)} onExit={markExited} onToast={notify} appearance={appearance}/>
      : null;
  return <TooltipProvider delayDuration={250}><div id="windowbar"><Tooltip><TooltipTrigger asChild><Button id="settings-button" type="button" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings aria-hidden="true"/></Button></TooltipTrigger><TooltipContent>Settings</TooltipContent></Tooltip></div><main style={{ gridTemplateColumns: `${railWidth}px 1px minmax(0, 1fr)` }}><WorkspaceRail workspaces={workspaces} activeId={activeWs} onOpen={openWorkspace} onCreate={createWorkspace} onDelete={deleteWorkspace}/><RailResizeGrip width={railWidth} setWidth={setRailWidth}/><section id="col"><div className="view on"><AgentGraph workspaceId={activeWs} onOpenTerminal={openRootTerminal} onOpenSubagent={openSubagent} sidePanel={sidePanel}/></div></section></main>{settingsOpen && <SettingsModal appearance={appearance} onChange={setAppearance} onClose={() => setSettingsOpen(false)}/>}<div id="toast" className={toast ? "show" : ""} role="status" aria-live="polite">{toast}</div></TooltipProvider>;
}
