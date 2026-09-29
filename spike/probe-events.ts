import { createOpencodeServer } from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const TEST_DIR = new URL("./sandbox", import.meta.url).pathname;
const ac = new AbortController();
const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, signal: ac.signal });
const client = createOpencodeClient({ baseUrl: server.url, directory: TEST_DIR });
console.log("server:", server.url);

const sess: any = await client.session.create({ directory: TEST_DIR });
const sid = sess.data.id;
console.log("session:", sid);

const seen: Record<string, number> = {};
const tap = (label: string) => async (source: AsyncIterable<any>) => {
  try {
    for await (const ev of source) {
      const t = ev?.type ?? ev?.properties?.type ?? JSON.stringify(ev).slice(0, 60);
      seen[t] = (seen[t] ?? 0) + 1;
      if (label === "GLOBAL" || seen[t] <= 2) {
        console.log(`  [${label}] ${t} :: ${JSON.stringify(ev).slice(0, 220)}`);
      }
    }
  } catch (e: any) {
    console.log(`  [${label}] STREAM ERROR: ${e?.message ?? e}`);
  }
};

// two candidate transports
const jobs: Promise<void>[] = [];

const globalSub: any = await client.event.subscribe();
console.log("global sub:", JSON.stringify(globalSub).slice(0, 120));
if (globalSub?.stream) jobs.push(tap("GLOBAL")(globalSub.stream));

const sessSub: any = await client.v2.session.events({ sessionID: sid });
console.log("session sub:", JSON.stringify(sessSub).slice(0, 120));
if (sessSub?.stream) jobs.push(tap("SESSION")(sessSub.stream));

const rawResp = await fetch(`${server.url}/api/session/${sid}/events`, { headers: { accept: "text/event-stream" } });
console.log("raw /events status:", rawResp.status, rawResp.headers.get("content-type"));
if (rawResp.ok) {
  const reader = rawResp.body!.getReader();
  const dec = new TextDecoder();
  const rawTap = (async () => {
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const line of buf.split("\n")) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6).trim();
            const t = (() => { try { return JSON.parse(payload).type; } catch { return payload.slice(0, 40); } })();
            seen["RAW:" + t] = (seen["RAW:" + t] ?? 0) + 1;
          }
        }
        buf = buf.slice(buf.lastIndexOf("\n") + 1);
      }
    } catch (e: any) { console.log("  [RAW] err", e?.message); }
  })();
  jobs.push(rawTap);
}

console.log("--- sending prompt ---");
const p: any = await client.session.prompt({
  sessionID: sid,
  parts: [{ type: "text", text: "Run the shell command: echo hi. Then reply with just OK." }],
});
console.log("prompt done, finish:", p?.data?.info?.finish, "tokens:", JSON.stringify(p?.data?.info?.tokens));

await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 6000))]);

console.log("--- histogram ---");
for (const [k, v] of Object.entries(seen).sort((a, b) => b[1] - a[1])) console.log(`  ${v}x ${k}`);
if (Object.keys(seen).length === 0) console.log("  (nothing received on ANY transport)");

server.close();
ac.abort();
process.exit(0);
