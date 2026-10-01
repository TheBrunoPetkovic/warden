import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Ellipsis, FolderOpen, Pencil, Plus, Settings, Terminal, Trash2, X } from "lucide-react";
import { AgentGraph } from "./AgentGraph.jsx";
import { TerminalPane } from "./TerminalPane.jsx";
import { Button } from "./components/ui/button.jsx";
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogTitle } from "./components/ui/dialog.jsx";
import { Input } from "./components/ui/input.jsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip.jsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu.jsx";

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

const DEFAULT_SETTINGS = {
  appearance: { theme: "system", scheme: "tokyo-night", accent: "", density: "comfortable", reduceMotion: false },
  terminal: { shell: "/bin/zsh", fontFamily: "system", fontSize: 13, scrollback: 50000, cursorStyle: "bar", cursorBlink: true, keybinding: "macos" },
  agents: { runtime: "opencode", autoOpen: true, hideCompleted: false, refreshSeconds: 2 },
  workspace: { location: "", confirmDelete: true, defaultTerminalCount: 1 },
  notifications: { input: true, complete: false, failed: true },
};

const readSettings = () => {
  try {
    const stored = JSON.parse(localStorage.getItem("warden.settings") ?? "{}");
    const legacyAppearance = JSON.parse(localStorage.getItem("warden.appearance") ?? "{}");
    return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([section, defaults]) => [section, { ...defaults, ...(section === "appearance" ? legacyAppearance : {}), ...(stored[section] ?? {}) }]));
  } catch { return DEFAULT_SETTINGS; }
};

function ChoiceGroup({ value, choices, onChange }) {
  return <div className="setting-choices">{choices.map(([id, label]) => <Button key={id} type="button" className={value === id ? "selected" : ""} onClick={() => onChange(id)}>{label}</Button>)}</div>;
}

function Toggle({ checked, onChange, label, description }) {
  return <div className="setting-toggle"><div><div>{label}</div>{description && <small>{description}</small>}</div><Button type="button" className={checked ? "switch on" : "switch"} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span/></Button></div>;
}

function SettingsModal({ settings, onChange, onClose }) {
  const [section, setSection] = useState("appearance");
  const update = (key, patch) => onChange({ ...settings, [key]: { ...settings[key], ...patch } });
  const updateNotification = (key, value) => {
    if (value && window.Notification?.permission === "default") void window.Notification.requestPermission();
    update("notifications", { [key]: value });
  };
  const sections = [["appearance", "Appearance"], ["terminal", "Terminal"], ["agents", "Agents"], ["workspace", "Workspace"], ["notifications", "Notifications"]];
  const title = sections.find(([id]) => id === section)?.[1];
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogOverlay id="settings-backdrop"/><DialogContent id="settings-modal"><aside id="settings-nav"><div className="settings-nav-label">Settings</div>{sections.map(([id, label]) => <Button key={id} className={`settings-nav-item ${section === id ? "active" : ""}`} type="button" onClick={() => setSection(id)}>{label}</Button>)}</aside><div id="settings-content"><header className="settings-header"><DialogTitle id="settings-title">{title}</DialogTitle><DialogClose asChild><Button className="icon-btn" type="button" aria-label="Close settings"><X aria-hidden="true"/></Button></DialogClose></header>{section === "appearance" && <><section className="settings-group"><div className="settings-group-title">Theme</div><div className="theme-options">{[["dark", "Dark"], ["light", "Light"], ["system", "System"]].map(([id, label]) => <Button key={id} type="button" className={`theme-option ${settings.appearance.theme === id ? "selected" : ""}`} onClick={() => update("appearance", { theme: id })}><span className={`theme-preview ${id}`}/><span>{label}</span></Button>)}</div></section><section className="settings-group"><div className="settings-group-title">Color scheme</div><div className="scheme-options">{SCHEMES.map(([id, label, color]) => <Button key={id} type="button" className={`scheme-option ${settings.appearance.scheme === id ? "selected" : ""}`} onClick={() => update("appearance", { scheme: id })}><i style={{ "--swatch": color }}/><span>{label}</span>{settings.appearance.scheme === id && <b>✓</b>}</Button>)}</div></section><section className="settings-group"><div className="settings-group-title">Interface</div><div className="setting-row"><span>Accent color</span><input className="setting-color" type="color" value={settings.appearance.accent || "#7aa2f7"} onChange={event => update("appearance", { accent: event.target.value })}/><Button type="button" className="reset-accent" onClick={() => update("appearance", { accent: "" })}>Use scheme</Button></div><ChoiceGroup value={settings.appearance.density} choices={[["compact", "Compact"], ["comfortable", "Comfortable"]]} onChange={density => update("appearance", { density })}/><Toggle checked={settings.appearance.reduceMotion} onChange={reduceMotion => update("appearance", { reduceMotion })} label="Reduce motion" description="Turns off graph pulses and interface transitions."/></section></>}{section === "terminal" && <><section className="settings-group"><div className="settings-group-title">Typography</div><div className="setting-field"><span>Font family</span><ChoiceGroup value={settings.terminal.fontFamily} choices={[["system", "System Mono"], ["menlo", "Menlo"], ["jetbrains", "JetBrains Mono"]]} onChange={fontFamily => update("terminal", { fontFamily })}/></div><div className="setting-field"><span>Font size</span><ChoiceGroup value={String(settings.terminal.fontSize)} choices={[["12", "12 px"], ["13", "13 px"], ["14", "14 px"], ["16", "16 px"]]} onChange={fontSize => update("terminal", { fontSize: Number(fontSize) })}/></div><div className="setting-field"><span>Scrollback</span><ChoiceGroup value={String(settings.terminal.scrollback)} choices={[["10000", "10k"], ["50000", "50k"], ["100000", "100k"]]} onChange={scrollback => update("terminal", { scrollback: Number(scrollback) })}/></div></section><section className="settings-group"><div className="settings-group-title">Behavior</div><div className="setting-field"><span>Default shell</span><ChoiceGroup value={settings.terminal.shell} choices={[["/bin/zsh", "zsh"], ["/bin/bash", "bash"]]} onChange={shell => update("terminal", { shell })}/></div><div className="setting-field"><span>Cursor style</span><ChoiceGroup value={settings.terminal.cursorStyle} choices={[["bar", "Bar"], ["block", "Block"], ["underline", "Underline"]]} onChange={cursorStyle => update("terminal", { cursorStyle })}/></div><div className="setting-field"><span>Keybindings</span><ChoiceGroup value={settings.terminal.keybinding} choices={[["default", "Default"], ["macos", "macOS"], ["vscode", "VS Code"]]} onChange={keybinding => update("terminal", { keybinding })}/></div><Toggle checked={settings.terminal.cursorBlink} onChange={cursorBlink => update("terminal", { cursorBlink })} label="Cursor blink"/></section></>}{section === "agents" && <><section className="settings-group"><div className="settings-group-title">Defaults</div><div className="setting-field"><span>Preferred runtime</span><ChoiceGroup value={settings.agents.runtime} choices={[["opencode", "OpenCode"], ["codex", "Codex"], ["claude", "Claude"]]} onChange={runtime => update("agents", { runtime })}/></div><div className="setting-field"><span>Graph refresh</span><ChoiceGroup value={String(settings.agents.refreshSeconds)} choices={[["1", "1 sec"], ["2", "2 sec"], ["5", "5 sec"]]} onChange={refreshSeconds => update("agents", { refreshSeconds: Number(refreshSeconds) })}/></div></section><section className="settings-group"><div className="settings-group-title">Behavior</div><Toggle checked={settings.agents.autoOpen} onChange={autoOpen => update("agents", { autoOpen })} label="Open newly started agent" description="Automatically opens the terminal of a new root agent."/><Toggle checked={settings.agents.hideCompleted} onChange={hideCompleted => update("agents", { hideCompleted })} label="Hide completed agents"/></section></>}{section === "workspace" && <><section className="settings-group"><div className="settings-group-title">Creation</div><label className="setting-text-input"><span>Default location</span><Input value={settings.workspace.location} onChange={event => update("workspace", { location: event.target.value })} placeholder="Warden managed location"/><small>Leave empty to use Warden’s managed workspace directory.</small></label><div className="setting-field"><span>Terminals on creation</span><ChoiceGroup value={String(settings.workspace.defaultTerminalCount)} choices={[["1", "1"], ["2", "2"], ["3", "3"]]} onChange={defaultTerminalCount => update("workspace", { defaultTerminalCount: Number(defaultTerminalCount) })}/></div></section><section className="settings-group"><Toggle checked={settings.workspace.confirmDelete} onChange={confirmDelete => update("workspace", { confirmDelete })} label="Confirm before deleting a workspace"/></section></>}{section === "notifications" && <><section className="settings-group"><div className="settings-group-title">Desktop notifications</div><Toggle checked={settings.notifications.input} onChange={input => updateNotification("input", input)} label="Agent needs input"/><Toggle checked={settings.notifications.complete} onChange={complete => updateNotification("complete", complete)} label="Agent completed"/><Toggle checked={settings.notifications.failed} onChange={failed => updateNotification("failed", failed)} label="Agent failed"/></section></>}</div></DialogContent></Dialog>;
}

function RenameWorkspaceDialog({ workspace, onClose, onRename }) {
  const [name, setName] = useState(workspace.name);
  const submit = async event => {
    event.preventDefault();
    if (!name.trim() || name.trim() === workspace.name) return onClose();
    await onRename(workspace, name.trim());
    onClose();
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogOverlay id="settings-backdrop"/><DialogContent id="rename-modal"><form onSubmit={submit}><header><DialogTitle>Rename workspace</DialogTitle><DialogClose asChild><Button className="icon-btn" type="button" aria-label="Close rename dialog"><X aria-hidden="true"/></Button></DialogClose></header><Input value={name} onChange={event => setName(event.target.value)} aria-label="Workspace name" autoFocus/><footer><Button type="button" className="dialog-button" onClick={onClose}>Cancel</Button><Button type="submit" className="dialog-button primary">Save</Button></footer></form></DialogContent></Dialog>;
}

function WorkspaceRail({ workspaces, activeId, onOpen, onNewTerminal, onCreate, onRename, onReveal, onCopy, onDelete }) {
  const [name, setName] = useState("");
  const [menuFor, setMenuFor] = useState(null);
  const submit = async event => {
    event.preventDefault();
    if (!name.trim()) return;
    await onCreate(name.trim());
    setName("");
  };
  return <nav id="rail"><div className="rail-head">Workspaces <span className="count">{workspaces.length || ""}</span></div><div id="wslist">{workspaces.map(workspace => <div key={workspace.id} className={`ws${workspace.id === activeId ? " sel" : ""}${workspace.missing ? " gone" : ""}`} role="button" tabIndex="0" onClick={() => onOpen(workspace)} onContextMenu={event => { event.preventDefault(); setMenuFor(workspace.id); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(workspace); } }}><div className="body"><div className="name">{workspace.name}{workspace.terminals > 0 && <span className="term-count" title={`${workspace.terminals} active terminals`}>{workspace.terminals}</span>}</div><div className="path">{workspace.path}</div></div><DropdownMenu open={menuFor === workspace.id} onOpenChange={open => setMenuFor(open ? workspace.id : null)}><DropdownMenuTrigger asChild><Button className="workspace-menu-trigger" type="button" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} title={`Workspace actions for ${workspace.name}`} aria-label={`Workspace actions for ${workspace.name}`}><Ellipsis aria-hidden="true"/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => onOpen(workspace)} disabled={workspace.missing}><Terminal aria-hidden="true"/>Open terminal</DropdownMenuItem><DropdownMenuItem onSelect={() => onNewTerminal(workspace)} disabled={workspace.missing}><Plus aria-hidden="true"/>New terminal</DropdownMenuItem><DropdownMenuSeparator className="workspace-menu-separator"/><DropdownMenuItem onSelect={() => onRename(workspace)}><Pencil aria-hidden="true"/>Rename workspace</DropdownMenuItem><DropdownMenuItem onSelect={() => onReveal(workspace)} disabled={workspace.missing}><FolderOpen aria-hidden="true"/>Reveal in Finder</DropdownMenuItem><DropdownMenuItem onSelect={() => onCopy(workspace)}><Copy aria-hidden="true"/>Copy workspace path</DropdownMenuItem><DropdownMenuSeparator className="workspace-menu-separator"/><DropdownMenuItem className="danger" onSelect={() => onDelete(workspace)}><Trash2 aria-hidden="true"/>{workspace.missing ? "Forget workspace" : "Delete workspace"}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>)}</div><form id="newws" onSubmit={submit}><Input value={name} onChange={event => setName(event.target.value)} placeholder="new workspace" autoComplete="off" spellCheck="false" aria-label="New workspace name"/><Button className="icon-btn" type="submit" title="Create workspace" aria-label="Create workspace"><Plus aria-hidden="true"/></Button></form></nav>;
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

function WorkspaceTerminalList({ terminals, selectedId, onSelect, onNewTerminal }) {
  return <div id="terminal-switcher"><header><span>Terminals</span><Button type="button" className="new-terminal" onClick={onNewTerminal} title="New terminal" aria-label="New terminal"><Plus aria-hidden="true"/></Button></header><div className="terminal-list">{terminals.map(item => <Button type="button" key={item.id} className={`terminal-list-item ${item.id === selectedId ? "selected" : ""}`} onClick={() => onSelect(item)}><span className={`terminal-state ${item.dead ? "exited" : "active"}`}/><span className="terminal-label">terminal · {item.id}</span><span className="terminal-meta">{item.dead ? "exited" : "active"}</span></Button>)}</div></div>;
}

function SideTerminal({ node, terminal, terminals, workspaceName, width, setWidth, onClose, onExit, onToast, onSelectTerminal, onNewTerminal, appearance, terminalSettings }) {
  const meta = node?.workspaceTerminal ? `terminal · ${terminal.id}` : node?.live ? `${node.runtime} · pid ${node.pid}` : `${node?.runtime ?? "terminal"} subagent · ${terminal.id}`;
  return <div id="sidepanel" style={{ "--side-w": `${width}px` }}><ResizeGrip width={width} setWidth={setWidth}/><div id="sidehead" tabIndex="-1"><span className="t">{node?.title ?? `${workspaceName} terminal`}</span><span className="m">{meta}</span><span className="spacer"/><Button className="icon-btn" type="button" onClick={onClose} title="Close terminal panel" aria-label="Close terminal panel"><X aria-hidden="true"/></Button></div><WorkspaceTerminalList terminals={terminals} selectedId={terminal.id} onSelect={onSelectTerminal} onNewTerminal={onNewTerminal}/><div id="sideterm"><TerminalPane terminal={terminal} startupInput={terminal.startupInput} onExit={onExit} onError={onToast} appearance={appearance} settings={terminalSettings}/></div></div>;
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
  const [renameTarget, setRenameTarget] = useState(null);
  const [settings, setSettings] = useState(readSettings);
  const appearance = settings.appearance;
  const terminals = termsByWorkspace[activeWs] ?? [];
  const notify = useCallback(message => {
    setToast(message);
    window.setTimeout(() => setToast(current => current === message ? "" : current), 4000);
  }, []);
  const notifyAgent = useCallback(node => {
    const enabled = node.visualState === "needs-input"
      ? settings.notifications.input
      : node.visualState === "failed"
        ? settings.notifications.failed
        : settings.notifications.complete;
    if (enabled && window.Notification?.permission === "granted") {
      new window.Notification("Warden", { body: `${node.title}: ${node.visualState.replaceAll("-", " ")}` });
    }
  }, [settings.notifications]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = appearance.theme === "system" ? (media.matches ? "dark" : "light") : appearance.theme;
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.scheme = appearance.scheme;
      document.documentElement.dataset.density = appearance.density;
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.classList.toggle("reduce-motion", appearance.reduceMotion);
      if (appearance.accent) document.documentElement.style.setProperty("--accent", appearance.accent);
      else document.documentElement.style.removeProperty("--accent");
    };
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem("warden.settings", JSON.stringify(settings));
    return () => media.removeEventListener("change", apply);
  }, [appearance, settings]);
  const updateSettings = next => setSettings(next);
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
  const openWorkspace = useCallback(async (workspace, { fresh = false } = {}) => {
    if (workspace.missing) return notify(`"${workspace.name}" — its directory no longer exists.`);
    try {
      setActiveWs(workspace.id);
      const existing = fresh ? null : (await syncTerminals(workspace.id)).find(terminal => !terminal.dead);
      if (existing) {
        setSide({ kind: "terminal", termId: existing.id, node: { title: `${workspace.name} terminal`, workspaceTerminal: true } });
        return;
      }
      const terminal = await api("/api/terminals", { method: "POST", body: { workspaceId: workspace.id, shell: settings.terminal.shell } });
      const next = { ...terminal, dead: false };
      setTermsByWorkspace(current => ({ ...current, [workspace.id]: [...(current[workspace.id] ?? []), next] }));
      void loadWorkspaces();
      setSide({ kind: "terminal", termId: next.id, node: { title: `${workspace.name} terminal`, workspaceTerminal: true } });
    } catch (error) { notify(error.message); }
  }, [loadWorkspaces, notify, settings.terminal.shell, syncTerminals]);
  const openNewTerminal = useCallback(workspace => openWorkspace(workspace, { fresh: true }), [openWorkspace]);
  const createWorkspace = async name => {
    try {
      const workspace = await api("/api/workspaces", { method: "POST", body: { name, basePath: settings.workspace.location || undefined } });
      await loadWorkspaces();
      await openWorkspace(workspace);
      for (let index = 1; index < settings.workspace.defaultTerminalCount; index++) await openNewTerminal(workspace);
    } catch (error) { notify(error.message); }
  };
  const renameWorkspace = async (workspace, name) => {
    try { await api(`/api/workspaces/${workspace.id}`, { method: "PATCH", body: { name } }); await loadWorkspaces(); } catch (error) { notify(error.message); }
  };
  const revealWorkspace = async workspace => {
    try { await api(`/api/workspaces/${workspace.id}/reveal`, { method: "POST" }); } catch (error) { notify(error.message); }
  };
  const copyWorkspacePath = async workspace => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard is unavailable");
      await navigator.clipboard.writeText(workspace.path);
      notify("Workspace path copied");
    } catch (error) { notify(`copy path: ${error.message}`); }
  };
  const deleteWorkspace = async workspace => {
    if (!workspace.missing && settings.workspace.confirmDelete && !window.confirm(`Delete workspace "${workspace.name}"? Its directory and running terminals are removed.`)) return;
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
    void loadWorkspaces();
  }, [activeWs, loadWorkspaces]);
  const openRootTerminal = node => {
    const terminal = terminals.find(item => item.id === node.terminalId);
    if (!terminal) return notify(`terminal ${node.terminalId} is no longer in this workspace`);
    if (terminal.dead) return notify(`terminal ${node.terminalId} has exited`);
    setSide({ kind: "terminal", termId: terminal.id, node });
  };
  const openSubagent = node => { setSide({ kind: "subagent", node }); };
  const selectWorkspaceTerminal = terminal => {
    const workspace = workspaces.find(item => item.id === activeWs);
    setSide({ kind: "terminal", termId: terminal.id, node: { title: `${workspace?.name ?? "workspace"} terminal`, workspaceTerminal: true } });
  };
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeWs);
  const sideTerminal = side?.kind === "terminal" ? terminals.find(terminal => terminal.id === side.termId) : null;
  const sidePanel = side?.kind === "subagent"
    ? <SubagentActivity node={side.node} width={sideWidth} setWidth={setSideWidth} onClose={() => setSide(null)} onToast={notify}/>
    : sideTerminal ? <SideTerminal node={side.node} terminal={sideTerminal} terminals={terminals} workspaceName={activeWorkspace?.name ?? "workspace"} width={sideWidth} setWidth={setSideWidth} onClose={() => setSide(null)} onExit={markExited} onToast={notify} onSelectTerminal={selectWorkspaceTerminal} onNewTerminal={() => activeWorkspace && openNewTerminal(activeWorkspace)} appearance={appearance} terminalSettings={settings.terminal}/>
      : null;
  return <TooltipProvider delayDuration={250}><div id="windowbar"><Tooltip><TooltipTrigger asChild><Button id="settings-button" type="button" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings aria-hidden="true"/></Button></TooltipTrigger><TooltipContent>Settings</TooltipContent></Tooltip></div><main style={{ gridTemplateColumns: `${railWidth}px 1px minmax(0, 1fr)` }}><WorkspaceRail workspaces={workspaces} activeId={activeWs} onOpen={openWorkspace} onNewTerminal={openNewTerminal} onCreate={createWorkspace} onRename={setRenameTarget} onReveal={revealWorkspace} onCopy={copyWorkspacePath} onDelete={deleteWorkspace}/><RailResizeGrip width={railWidth} setWidth={setRailWidth}/><section id="col"><div className="view on"><AgentGraph workspaceId={activeWs} onOpenTerminal={openRootTerminal} onOpenSubagent={openSubagent} sidePanel={sidePanel} autoOpen={settings.agents.autoOpen} hideCompleted={settings.agents.hideCompleted} refreshSeconds={settings.agents.refreshSeconds} onAgentNotification={notifyAgent}/></div></section></main>{settingsOpen && <SettingsModal settings={settings} onChange={updateSettings} onClose={() => setSettingsOpen(false)}/>} {renameTarget && <RenameWorkspaceDialog workspace={renameTarget} onClose={() => setRenameTarget(null)} onRename={renameWorkspace}/>}<div id="toast" className={toast ? "show" : ""} role="status" aria-live="polite">{toast}</div></TooltipProvider>;
}
