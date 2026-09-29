import { createOpencodeServer } from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const TEST_DIR = new URL("./sandbox", import.meta.url).pathname;
const PROMPT =
  "Create a file named probe.txt containing the single word WARDEN, then read it back and tell me its contents. Keep it to exactly two tool calls.";

const log = (...a: unknown[]) => console.log(...a);
const events: string[] = [];
let sessionID: string | undefined;

function describe(ev: any): string {
  const type = ev?.type ?? ev?.event?.type ?? "unknown";
  events.push(type);
  const bits: string[] = [type];
  if (ev?.properties?.permissionID) bits.push(`id=${ev.properties.permissionID}`);
  if (ev?.properties?.tool) bits.push(`tool=${ev.properties.tool}`);
  if (ev?.properties?.sessionID) bits.push(`sid=${ev.properties.sessionID.slice(0, 8)}`);
  if (ev?.properties?.error) bits.push(`ERROR=${ev.properties.error}`);
  return bits.join(" ");
}

async function main() {
  const ac = new AbortController();
  log("→ starting opencode server on a free port…");
  const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, signal: ac.signal });
  log(`  server: ${server.url}`);

  const client = createOpencodeClient({ baseUrl: server.url, directory: TEST_DIR });
  log("→ introspecting client namespaces…");
  log("  top: " + Object.keys(client).join(", "));
  log("  v2.session: " + Object.getOwnPropertyNames(Object.getPrototypeOf(client.v2.session)).filter((x) => x !== "constructor").join(", "));
  log("  v2.session.permission: " + Object.keys(client.v2.session.permission ?? {}).join(", "));
  log("  permission: " + Object.getOwnPropertyNames(Object.getPrototypeOf(client.permission)).filter((x) => x !== "constructor").join(", "));

  const dir = TEST_DIR;
  log(`→ creating session in ${dir}`);
  const created: any = await client.session.create({ directory: dir });
  sessionID = created?.data?.id ?? created?.id;
  log(`  sessionID: ${sessionID}  slug=${created?.data?.slug}  cost=${created?.data?.cost}`);

  log("→ subscribing to durable session events…");
  const sub: any = await client.v2.session.events({ sessionID: sessionID! });
  log(`  stream: ${sub?.stream ? "AsyncGenerator OK" : "MISSING " + JSON.stringify(sub).slice(0, 200)}`);

  log("→ replaying history (durability check)…");
  try {
    const hist: any = await client.v2.session.history({ sessionID: sessionID!, limit: 5 });
    const items = hist?.data?.items ?? hist?.data ?? hist?.items;
    log(`  history returned ${Array.isArray(items) ? items.length : "?"} items`);
  } catch (e: any) {
    log("  HISTORY ERROR: " + (e?.message ?? e));
  }

  let idle = false;
  const pump = (async () => {
    for await (const ev of sub.stream as AsyncIterable<any>) {
      const d = describe(ev);
      const t = String(ev?.type ?? "");
      if (t.startsWith("permission.") || t.includes("Tool") || t.includes("step") || t.toLowerCase().includes("error")) {
        log("  EVENT " + d);
      }
      if (t === "permission.asked") {
        const pid = ev?.properties?.permissionID ?? ev?.properties?.id;
        log(`  >>> PERMISSION ASKED: ${pid} — replying "once"`);
        try {
          const r = await client.permission.reply({
            sessionID: sessionID!,
            permissionID: pid,
            reply: "once",
          });
          log("  >>> reply: " + JSON.stringify(r).slice(0, 200));
        } catch (e: any) {
          log("  >>> REPLY FAILED: " + (e?.message ?? e));
        }
      }
      if (t === "session.idle" || t === "step.finished") idle = true;
    }
  })();

  log(`→ sending prompt: ${PROMPT.slice(0, 50)}…`);
  const t0 = Date.now();
  try {
    const res = await client.session.prompt({
      sessionID: sessionID!,
      parts: [{ type: "text", text: PROMPT }],
    });
    log(`  prompt returned in ${Date.now() - t0}ms`);
    log("  " + JSON.stringify(res).slice(0, 500));
  } catch (e: any) {
    log("  PROMPT ERROR: " + (e?.message ?? e));
  }

  await Promise.race([pump, new Promise((r) => setTimeout(r, 10000))]);

  const counts = new Map<string, number>();
  for (const e of events) counts.set(e, (counts.get(e) ?? 0) + 1);
  log("→ event histogram:");
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) log(`   ${v}x  ${k}`);

  log("→ message history (what the agent actually did):");
  try {
    const msgs: any = await client.session.messages({ sessionID: sessionID! });
    const arr = msgs?.data ?? msgs ?? [];
    log(`  ${Array.isArray(arr) ? arr.length : "?"} messages`);
    for (const m of (Array.isArray(arr) ? arr : []).slice(-6)) {
      for (const p of (m.parts ?? [])) {
        if (p.type === "text") log(`    text: ${String(p.text).slice(0, 120)}`);
        if (p.type === "tool") log(`    tool: ${p.tool} state=${p.state?.status ?? "?"}`);
      }
    }
  } catch (e: any) {
    log("  MESSAGES ERROR: " + (e?.message ?? e));
  }

  log("→ pending permissions (list):");
  try {
    const pl = await client.permission.list({ sessionID: sessionID! });
    log("  " + JSON.stringify(pl).slice(0, 300));
  } catch (e: any) {
    log("  LIST ERROR: " + (e?.message ?? e));
  }

  server.close();
  ac.abort();
  process.exit(0);
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e);
  process.exit(1);
});
