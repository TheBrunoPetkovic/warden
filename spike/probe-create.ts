import { createOpencodeServer } from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const TEST_DIR = new URL("./sandbox", import.meta.url).pathname;

const ac = new AbortController();
const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, signal: ac.signal });
const client = createOpencodeClient({ baseUrl: server.url, directory: TEST_DIR });
console.log("server:", server.url, "dir:", TEST_DIR);

const attempts: Array<[string, () => Promise<any>]> = [
  ["v2 create body:{} ", () => client.v2.session.create({ body: {} })],
  ["v2 create body:{agent:build}", () => client.v2.session.create({ body: { agent: "build" } })],
  ["v1 create {}    ", () => client.session.create({})],
  ["v1 create dir   ", () => client.session.create({ directory: TEST_DIR })],
  ["v1 list         ", () => client.session.list({})],
  ["v2 list         ", () => client.v2.session.list({})],
];

for (const [name, fn] of attempts) {
  try {
    const r: any = await fn();
    const s = JSON.stringify(r);
    console.log(`OK   ${name} -> ${s.slice(0, 220)}`);
  } catch (e: any) {
    console.log(`FAIL ${name} -> ${e?.message ?? e}`);
  }
}

server.close();
ac.abort();
process.exit(0);
