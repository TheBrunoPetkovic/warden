import { createOpencodeServer } from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createServer } from "node:net";

const TEST_DIR = new URL("./sandbox", import.meta.url).pathname;
const REPLY = (process.env.WARDEN_REPLY ?? "once") as "once" | "always" | "reject";

// port:0 is ignored by the SDK (0 is falsy) -> it falls back to 4096. Allocate explicitly.
const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => res(p));
    });
  });

const ac = new AbortController();
const port = await freePort();
const server = await createOpencodeServer({ hostname: "127.0.0.1", port, signal: ac.signal });
const client = createOpencodeClient({ baseUrl: server.url, directory: TEST_DIR });
console.log("server:", server.url, "| reply:", REPLY);

const sess: any = await client.session.create({ directory: TEST_DIR });
const sid = sess.data.id;
console.log("session:", sid);

const seen: Record<string, number> = {};
let asked = 0, replied = 0, done = false;

const sub: any = await client.event.subscribe();
const pump = (async () => {
  try {
    for await (const ev of sub.stream as AsyncIterable<any>) {
      const t = ev?.type ?? "?";
      seen[t] = (seen[t] ?? 0) + 1;
      if (t === "session.idle") done = true;

      if (t === "permission.asked" || t === "permission.updated") {
        const p = ev.properties;
        const status = p?.status ?? p?.reply ?? (t === "permission.asked" ? "pending" : "?");
        console.log(`\n>>> ${t}  status=${status}`);
        console.log("    " + JSON.stringify(p).slice(0, 500));
        if (t === "permission.asked" || status === "pending" || status === "asking") {
          asked++;
          const pid = p?.id ?? p?.permissionID;
          // SDK's respond() drops the body (serializer bug). Use the HTTP endpoint directly.
          const r: any = await fetch(`${server.url}/session/${sid}/permissions/${pid}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response: REPLY }),
          }).then(async (res) => ({ status: res.status, body: (await res.text()).slice(0, 200) }))
            .catch((e: any) => ({ err: e?.message ?? String(e) }));
          console.log(`    >>> reply("${REPLY}") -> ` + JSON.stringify(r).slice(0, 200));
          if (!r?.err) replied++;
        }
      }
      if (t === "permission.replied") {
        console.log("    << permission.replied " + JSON.stringify(ev.properties).slice(0, 200));
      }
    }
  } catch (e: any) {
    console.log("pump ended:", e?.message ?? e);
  }
})();

console.log("\n--- sending via promptAsync (non-blocking) ---");
const sent: any = await (client.session.promptAsync as any)({
  sessionID: sid,
  parts: [{ type: "text", text: "Run this shell command: echo WARDEN_PERM_PROBE . Then reply OK." }],
}).catch((e: any) => ({ err: e?.message ?? String(e) }));
console.log("promptAsync ->", JSON.stringify(sent).slice(0, 250));

// wait for idle (bounded)
const t0 = Date.now();
while (!done && Date.now() - t0 < 40_000) await new Promise((r) => setTimeout(r, 300));

console.log(`\n=== idle after ${Date.now() - t0}ms | asked=${asked} replied=${replied} ===`);

const msgs: any = await client.session.messages({ sessionID: sid }).catch((e: any) => ({ err: e?.message }));
if (msgs?.err) console.log("messages error:", msgs.err);
else for (const m of (msgs?.data ?? [])) for (const p of (m.parts ?? [])) {
  if (p.type === "text") console.log(`  text: ${String(p.text).slice(0, 100)}`);
  if (p.type === "tool") console.log(`  tool: ${p.tool} status=${p.state?.status}`);
}

const pl: any = await client.permission.list({}).catch((e: any) => ({ err: e?.message }));
console.log("pending permissions:", JSON.stringify(pl?.data ?? pl?.err).slice(0, 300));

console.log("\n--- histogram ---");
for (const [k, v] of Object.entries(seen).sort((a, b) => b[1] - a[1])) console.log(`  ${v}x ${k}`);

server.close();
ac.abort();
process.exit(0);
