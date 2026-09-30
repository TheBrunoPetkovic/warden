import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { EventBus } from "../core/events.ts";
import { OpencodeAdapter } from "../adapters/opencode.ts";
import { startServer } from "../server.ts";

const bus = new EventBus();
const adapter = new OpencodeAdapter(bus);
let localUrl = "";

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    title: "Warden",
    backgroundColor: "#111318",
    webPreferences: {
      // The renderer is a normal, sandboxed web page. PTYs and filesystem
      // access stay in the main process behind Warden's local API.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(localUrl)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(localUrl)) event.preventDefault();
  });
  void win.loadURL(localUrl);
}

app.setName("Warden");
app.whenReady().then(async () => {
  // The HTTP server is loopback-only and uses a random OS-assigned port. It is
  // an internal transport between this renderer and Warden's main process,
  // rather than a browser-facing development server.
  const uiDir = join(app.getAppPath(), "src", "ui", "dist");
  const port = await startServer(bus, adapter, 0, { uiDir });
  localUrl = `http://127.0.0.1:${port}`;
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}).catch(error => {
  console.error("[warden] desktop startup failed:", error);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => { void adapter.stop().catch(() => {}); });
