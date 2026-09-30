/**
 * Regression check for stale workspace records.
 *
 * The registry is `~/.warden/workspaces.json` and the directories it points at
 * live outside it, so the two drift apart: cleaning out ~/.warden, a test
 * removing its own sandbox, or an unmounted volume all leave records pointing
 * at nothing. Nothing reconciles them, and a record whose directory is gone
 * used to surface as a 500 with a stack trace out of the PTY pool plus, on
 * every page load, a failed auto-open of whatever record happened to sort first.
 *
 * This recreates that state deliberately -- creates a workspace, removes its
 * directory out of band -- and checks the four places it has to behave:
 * the API, the list payload, the rail rendering, and startup.
 */
import { chromium } from "playwright";
import { rm, mkdir, writeFile } from "node:fs/promises";

const EXE =
  process.env.HOME +
  "/Library/Caches/ms-playwright/chromium-1246/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = process.env.WARDEN_URL ?? "http://127.0.0.1:7788";

let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  PASS  " : "  FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fail++;
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors: string[] = [];
const spawns: string[] = [];
page.on("console", m => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", e => errors.push(String(e)));
page.on("request", r => {
  if (r.method() !== "POST" || !r.url().includes("/api/terminals")) return;
  try {
    spawns.push((r.postDataJSON() as { workspaceId: string }).workspaceId);
  } catch {}
});
page.on("dialog", d => d.accept());

const rows = () => page.locator(".ws").count();
const summary = async () => (await page.textContent("#summary")) ?? "";

// --- setup: a registry record whose directory vanished -------------------
const created = await (
  await page.request.post(`${BASE}/api/workspaces`, { data: { name: "e2e-zombie" } })
).json();
await mkdir(created.path, { recursive: true });
await writeFile(`${created.path}/opencode.json`, "{}");
await rm(created.path, { recursive: true, force: true });
console.log(
  `  setup: e2e-zombie (${created.id}) created, then its directory removed out of band\n`,
);

const before = (await (await page.request.get(`${BASE}/api/workspaces`)).json()).length;

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "connected");
await page.waitForTimeout(900);

// --- the API contract ---------------------------------------------------
const listed = (await (await page.request.get(`${BASE}/api/workspaces`)).json()) as {
  id: string;
  name: string;
  missing: boolean;
}[];
check("list still reports the record", listed.some(w => w.id === created.id));
check(
  "list flags it as missing",
  listed.find(w => w.id === created.id)?.missing === true,
  JSON.stringify(listed.find(w => w.id === created.id)),
);
check("a live workspace is not flagged", listed.filter(w => w.id !== created.id).every(w => !w.missing));

const spawn = await page.request.post(`${BASE}/api/terminals`, {
  data: { workspaceId: created.id, cols: 80, rows: 24 },
});
check(
  "POST /api/terminals on a dead record is 409, not 500",
  spawn.status() === 409,
  String(spawn.status()),
);
check("and the error names the directory", /directory is gone/.test(JSON.stringify(await spawn.json())));

// --- the rail -----------------------------------------------------------
check("the rail still lists it", (await rows()) === before, `${await rows()} of ${before}`);
check("it is marked gone", (await page.locator(".ws.gone").count()) === 1);
check(
  "its name is struck through",
  await page
    .locator(".ws.gone .name")
    .evaluate(e => getComputedStyle(e).textDecorationLine.includes("line-through")),
);
check("the summary counts it as missing", /1 missing/.test(await summary()), await summary());

// --- startup ------------------------------------------------------------
check(
  "load selected a live workspace, not the dead record",
  await page.evaluate(() => {
    const sel = document.querySelector(".ws.sel");
    return !!sel && !sel.classList.contains("gone");
  }),
);
check("no spawn ever targeted the dead record", !spawns.includes(created.id), `spawns=${JSON.stringify(spawns)}`);

// --- interaction --------------------------------------------------------
await page.locator(".ws.gone").first().click();
await page.waitForTimeout(400);
check(
  "clicking it explains instead of failing silently",
  /no longer exists/.test((await page.textContent("#toast")) ?? ""),
);
check("it never becomes active", !(await page.evaluate(() => !!document.querySelector(".ws.sel.gone"))));
check("still nothing in the console", errors.length === 0, errors.slice(0, 2).join(" | "));

// --- purge --------------------------------------------------------------
await page.locator(".ws.gone .kill").first().click();
await page.waitForFunction(n => document.querySelectorAll(".ws").length === n, before - 1, {
  timeout: 8000,
});
check("purged without a confirm dialog", (await rows()) === before - 1, `${await rows()}`);
check("the summary is clean again", !/missing/.test(await summary()), await summary());
check("still nothing in the console", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
console.log(fail ? `\n${fail} failed\n` : "\nall passed\n");
process.exit(fail ? 1 : 0);
