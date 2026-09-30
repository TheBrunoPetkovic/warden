/**
 * E2E for the terminal-only UI.
 *
 * The load-bearing assertion is the approval flow driven entirely through the
 * PTY: type `opencode`, type a prompt that needs a bash approval, press Enter
 * on the highlighted "Allow once", and confirm the command actually ran. That
 * is the path that replaced the chat panel, so it is the one that has to hold.
 */
import { chromium } from "playwright";

const BASE = process.env.WARDEN_URL ?? "http://127.0.0.1:7777";
const EXE = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1246/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const SLOW = process.env.SLOW ? 2 : 1;

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("console", m => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", e => errors.push(String(e)));
page.on("dialog", d => d.accept());

// Read xterm's live rows, not #screen: xterm recycles row nodes, so stale text
// from an earlier frame (e.g. an approval prompt already dismissed) lingers in
// textContent and makes "the prompt is gone" assertions always fail.
const screen = async () =>
  ((await page.textContent("#screen .xterm-rows")) || "").replace(/\s+/g, " ");
const settle = ms => page.waitForTimeout(ms * SLOW);

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#wslist", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "connected", { timeout: 10000 });
  console.log("\n→ app loaded, backend connected\n");

  // No chat surface anywhere.
  const chatCount = await page.locator("#log, #perms, #prompt").count();
  check("chat panel removed", chatCount === 0, `${chatCount} chat nodes found`);

  // --- workspace lifecycle ----------------------------------------------
  const name = `e2e-${Date.now().toString(36)}`;
  await page.fill("#wsname", name);
  await page.press("#wsname", "Enter");
  await page.waitForFunction(n => [...document.querySelectorAll(".ws .name")].some(e => e.textContent === n), name, { timeout: 10000 });
  check("workspace created", true, name);

  const statusPath = await page.textContent("#statuspath");
  check("status bar shows workspace path", /e2e-/.test(statusPath ?? ""), statusPath ?? "");

  await page.waitForSelector(".xterm-screen", { timeout: 10000 });
  check("terminal auto-opens for workspace", true);

  // --- plain pty round trip ---------------------------------------------
  await settle(2200);
  await page.click("#screen .xterm-screen");
  await page.keyboard.type("echo WARDEN_PTY_$((7*6))");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => (document.querySelector("#screen .xterm-rows")?.textContent || "").includes("WARDEN_PTY_42"),
    { timeout: 15000 },
  );
  check("terminal executes commands", true, "WARDEN_PTY_42");

  const pwdOut = await screen();
  check("shell cwd is the workspace", /\.warden[\\/]workspaces/.test(pwdOut));

  // --- tabs --------------------------------------------------------------
  const tabsBefore = await page.locator(".tab:not(.add)").count();
  await page.click(".tab.add .icon-btn");
  await page.waitForFunction(n => document.querySelectorAll(".tab:not(.add)").length > n, tabsBefore, { timeout: 10000 });
  check("second terminal opens as a tab", (await page.locator(".tab:not(.add)").count()) === tabsBefore + 1);
  // Switch to the newest tab (the one just opened), not the first match.
  await page.locator(".tab:not(.add)").last().click();
  await settle(1200);
  check("tab switch gives an independent shell", (await screen()).includes("WARDEN_PTY_42") === false);

  // --- approval through the pty -----------------------------------------
  // bash must ask: drop an opencode.json asking for permission in the workspace.
  const dir = (await page.evaluate(async () => {
    const w = await (await fetch("/api/workspaces")).json();
    return w.find(x => x.name.startsWith("e2e-")).path;
  }));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${dir}/opencode.json`, JSON.stringify({ permission: { edit: "ask", bash: "ask" } }, null, 2));

  // Use the first tab (the one holding the plain shell): distinct terminals
  // have distinct scrollback, so this avoids cross-terminal state.
  await page.locator(".tab:not(.add)").first().click();
  await settle(1000);
  await page.click("#screen .xterm-screen");
  await page.keyboard.type("opencode");
  await page.keyboard.press("Enter");
  await settle(13000);
  await page.keyboard.type("run the shell command: echo APPROVAL_PROBE . then reply done");
  await page.keyboard.press("Enter");

  // No .catch here on purpose: a swallowed timeout would assert against stale
  // screen content and report a prompt that was never shown.
  await page.waitForFunction(
    () => /Allow once/.test(document.querySelector("#screen .xterm-rows")?.textContent || ""),
    { timeout: 120000 },
  );
  const asked = await screen();
  check("opencode asks for approval in terminal", /Allow once/.test(asked), /Permission required/.test(asked) ? "permission prompt rendered" : "prompt text: " + asked.slice(-120));
  check("approval offers all three options", /Allow once/.test(asked) && /Allow always/.test(asked) && /Reject/.test(asked));

  // "Allow once" is the default selection, so Enter alone must approve.
  // The approval picker is a screen, not an overlay: once accepted, the whole
  // view is replaced. Assert the transition on a distinctive string from the
  // prompt view -- "Permission required" -- rather than the option labels, which
  // survive in recycled rows for a while after the redraw.
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => {
      const t = document.querySelector("#screen .xterm-rows")?.textContent || "";
      return /done/.test(t) && !/Permission required/.test(t);
    },
    { timeout: 120000 },
  );
  const after = await screen();
  check(
    "approval accepted with Enter",
    !/Permission required/.test(after) && !/Always allow/.test(after),
    /Always allow/.test(after) ? "left on a confirm step (BUG)" : /Permission required/.test(after) ? "prompt still shown" : "",
  );
  check("approved command actually ran", /APPROVAL_PROBE/.test(after));
  check("agent replied after approval", /done/.test(after));

  await page.screenshot({ path: "shot-6-terminal-ui.png" });

  // --- agents view: live processes in THIS workspace ----------------------
  // opencode is still running in this workspace's terminal at this point, so
  // there must be exactly one node, and it must be a real process.
  await page.click("#vgraph");
  await page.waitForFunction(
    () => /running/.test(document.querySelector("#graphinfo")?.textContent || ""),
    { timeout: 20000 },
  );
  await page.waitForFunction(
    () => /^1 running/.test((document.querySelector("#graphinfo")?.textContent || "").trim()),
    { timeout: 20000 },
  );
  check("agents view finds the running opencode", /^1 running/.test((await page.textContent("#graphinfo") || "").trim()), (await page.textContent("#graphinfo") || "").replace(/\s+/g, " "));
  check("agents view is scoped to the workspace", new RegExp(name).test(await page.textContent("#graphpath")));

  const listed = await page.locator("#agentlist button").evaluateAll(els =>
    els.map(e => e.getAttribute("aria-label") || ""));
  check("one accessible control per running agent", listed.length === 1, listed[0]);
  check("accessible control names the runtime and pid", /opencode, running, pid \d+/.test(listed[0] ?? ""), listed[0]);
  check("accessible control says what activating it does", /in terminal t\d+\. Dock that terminal beside the graph\./.test(listed[0] ?? ""), listed[0]);

  // The list used to be a 1px clipped element revealed only on :focus-visible,
  // which left the pointer with nothing to click. It is a real sidebar now.
  check("agent sidebar is visible without any keyboard focus", await page.locator("#agentlist button").first().isVisible());
  const sb = (await page.locator("#agentlist").boundingBox())!;
  const cv = (await page.locator("#graph").boundingBox())!;
  check("sidebar sits to the right of the canvas", sb.x >= cv.x + cv.width - 2, `sidebar x=${Math.round(sb.x)}, canvas ends x=${Math.round(cv.x + cv.width)}`);

  // The canvas is not a real interface on its own; the list has to mirror it.
  const painted = await page.evaluate(() => {
    const c = document.querySelector("#graph") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  check("canvas actually paints the node", painted > 200, `${painted} non-empty pixels`);

  // Activating an agent docks its shell beside the canvas. The old behaviour
  // switched the whole column over to the terminal, which threw away the graph
  // you clicked to get there — that is the regression this asserts against.
  await page.locator("#agentlist button").first().click();
  await page.waitForSelector("#sidepanel:not([hidden])", { timeout: 10000 });
  check("activating an agent does NOT leave the agents view", await page.isVisible("#graphview"));
  check("terminal view was not switched to", await page.isHidden("#termview"));
  check("the agent's terminal is docked in the side panel", await page.isVisible("#sidepanel"));
  check("canvas is still on screen next to it", await page.isVisible("#graph"));
  check("the docked panel hosts the only xterm", (await page.locator(".xterm").count()) === 1);
  check("side header shows runtime and pid", /opencode · pid \d+/.test((await page.textContent("#side-meta")) || ""), (await page.textContent("#side-meta")) || "");

  // The detail panel is the read-only surface and must stay out of the way of a
  // docked terminal. A subagent session has no shell, so it keeps that panel.
  check("detail panel stayed hidden for a live agent", await page.isHidden("#detail"));
  await page.click("#side-close");
  await page.waitForSelector("#sidepanel[hidden]", { state: "attached", timeout: 5000 });
  check("closing the panel returns the column to the list", await page.isVisible("#agentlist"));

  // The canvas stays read-only: a click there reports, it never navigates.
  const gb = (await page.locator("#graph").boundingBox())!;
  await page.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.waitForTimeout(500);
  check("clicking a live node docks its terminal, not a popover", await page.isHidden("#detail") && await page.isVisible("#sidepanel"));
  check("a canvas click does not navigate away", await page.isHidden("#termview"));
  await page.click("#sidehead");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#sidepanel[hidden]", { state: "attached", timeout: 5000 });

  // The whole point of reading the process table: kill the process and the node
  // has to disappear. A timestamp-based view could never pass this.
  const wsId = await page.evaluate(async n =>
    (await (await fetch("/api/workspaces")).json()).find((w: any) => w.name === n)?.id, name);
  const live = await page.evaluate(async id => (await (await fetch(`/api/live?workspaceId=${id}`)).json()).agents, wsId);
  check("agent reports a terminal it runs in", !!live[0]?.terminalId, `pid ${live[0]?.pid} in ${live[0]?.terminalId}`);

  process.kill(live[0].pid, "SIGKILL");
  await page.waitForFunction(
    () => /^0 running/.test((document.querySelector("#graphinfo")?.textContent || "").trim()),
    { timeout: 20000 },
  ).catch(() => {});
  check("node disappears when the process dies", /^0 running/.test((await page.textContent("#graphinfo") || "").trim()), (await page.textContent("#graphinfo") || "").replace(/\s+/g, " "));
  check("empty state appears with no agents", await page.isVisible("#gempty"));
  check("accessible list empties too", (await page.locator("#agentlist button").count()) === 0);

  // --- back to terminals -------------------------------------------------
  await page.click("#vterm");
  await page.waitForSelector("#screen .xterm", { timeout: 10000 });
  check("terminal survives a round trip to the agents view", (await page.locator("#screen .xterm").count()) === 1);

  // --- delete ------------------------------------------------------------
  await page.locator(".ws.sel .kill").click();
  await page.waitForFunction(n => ![...document.querySelectorAll(".ws .name")].some(e => e.textContent === n), name, { timeout: 10000 });
  check("workspace deleted", !(await page.locator(".ws").allTextContents()).some(t => t.includes(name)));

  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) {
  console.error("\n  ERROR:", e.message);
  failures++;
  await page.screenshot({ path: "shot-6-fail.png" }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}\n`);
process.exit(failures ? 1 : 0);
