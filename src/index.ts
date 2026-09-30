import { EventBus } from "./core/events.ts";
import { OpencodeAdapter } from "./adapters/opencode.ts";
import { startServer } from "./server.ts";
import { renderBanner } from "./ui/banner.ts";
import { WorkspaceStore } from "./workspaces/store.ts";

const PORT = Number(process.env.WARDEN_PORT ?? 7777);
const RUNTIME = "opencode" as const;
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (s: string) => (useColor ? `[1m${s}[22m` : s);
const dim = (s: string) => (useColor ? `[2m${s}[22m` : s);

const bus = new EventBus();
const adapter = new OpencodeAdapter(bus);

const shutdown = async (sig: string) => {
  console.log(`\n[warden] ${sig} — shutting down`);
  // Only tears down if it was ever started; stop() is safe on a cold adapter.
  await adapter.stop().catch(() => {});
  process.exit(0);
};
process.on("uncaughtException", e => console.error("[warden] uncaught:", e));
process.on("unhandledRejection", e => console.error("[warden] unhandled:", e));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  // The opencode server is started lazily by the SDK routes: agents run inside
  // the PTYs, so a terminal-only Warden should not pay for it.
  const store = new WorkspaceStore();
  const bound = await startServer(bus, adapter, PORT);
  const wsCount = (await store.list()).length;

  if (bound !== PORT) console.log(dim(`  port ${PORT} busy, using ${bound}`));
  console.log(renderBanner({ port: bound, workspaceCount: wsCount, runtimes: [RUNTIME] }));
  if (process.env.BROWSER !== "none") console.log(`  →  open ${bold(`http://127.0.0.1:${bound}`)}\n`);
} catch (e: any) {
  if (e?.name === "PortBusyError") {
    console.error(`\n[warden] port ${e.port} and the 10 ports after it are all in use.`);
    console.error("[warden] free one, or set WARDEN_PORT=<n>.\n");
  } else {
    console.error("[warden] failed to start:", e);
  }
  process.exit(1);
}
