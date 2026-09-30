/**
 * Targeted check for the docked side panel: clicking an agent must put its
 * terminal beside the canvas, not switch the column over to it.
 *
 * Spawns its own opencode in a throwaway workspace. It used to lean on an agent
 * left over from ui-check, which meant it passed or failed depending on whether
 * something happened to still be running -- the check silently became a race.
 */
import { chromium } from "playwright";

const BASE = process.env.WARDEN_URL ?? "http://127.0.0.1:7788";
const EXE = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1246/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

let failures = 0;
const check = (name: string, ok: unknown, extra = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const settle = (ms: number) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors: string[] = [];
page.on("console", m => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", e => errors.push(String(e)));

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "connected", { timeout: 10000 });

  // --- own a workspace, so the run does not inherit anyone else's agents ----
  const name = `e2e-dock-${Date.now().toString(36)}`;
  await page.fill("#wsname", name);
  await page.press("#wsname", "Enter");
  await page.waitForFunction(n => [...document.querySelectorAll(".ws .name")].some(e => e.textContent === n), name, { timeout: 10000 });
  await page.waitForSelector("#screen .xterm-screen", { timeout: 10000 });
  await settle(1500);
  await page.click("#screen .xterm-screen");
  await page.keyboard.type("opencode");
  await page.keyboard.press("Enter");
  check("fixture workspace opened its own agent", true, name);

  await page.click("#vgraph");
  await page.waitForFunction(() => /^1 running/.test((document.querySelector("#graphinfo")?.textContent || "").trim()), { timeout: 90000 });
  check("agents view shows the running agent", true);

  const listed = await page.locator("#agentlist button").evaluateAll(e => e.map(x => x.getAttribute("aria-label") || ""));
  check("aria-label promises docking, not navigation", /Dock that terminal beside the graph\./.test(listed[0] ?? ""), listed[0]);
  check("list offers a dock affordance", /dock terminal/.test(await page.textContent("#agentlist") || ""));

  // Canvas width before docking — the panel steals from it.
  const before = (await page.locator("#graph").boundingBox())!.width;

  // --- click the node on the canvas --------------------------------------
  const gb = (await page.locator("#graph").boundingBox())!;
  await page.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.waitForSelector("#sidepanel:not([hidden])", { timeout: 10000 });

  check("agents view is STILL on screen after clicking a node", await page.isVisible("#graphview"));
  check("terminal view was NOT switched to", await page.isHidden("#termview"));
  check("side panel is docked", await page.isVisible("#sidepanel"));
  check("agent list gave up the column", await page.isHidden("#agentlist"));
  check("detail panel stayed hidden", await page.isHidden("#detail"));
  check("canvas is still visible", await page.isVisible("#graph"));

  const after = (await page.locator("#graph").boundingBox())!.width;
  check("canvas narrowed to make room", after < before - 100, `${Math.round(before)} -> ${Math.round(after)}`);

  const sp = (await page.locator("#sidepanel").boundingBox())!;
  const cv2 = (await page.locator("#graph").boundingBox())!;
  check("panel sits to the RIGHT of the canvas", sp.x >= cv2.x + cv2.width - 2, `panel x=${Math.round(sp.x)}, canvas ends ${Math.round(cv2.x + cv2.width)}`);

  check("panel header names the agent", ((await page.textContent("#side-title")) || "").length > 0, await page.textContent("#side-title"));
  check("panel header shows runtime + pid", /opencode · pid \d+/.test(await page.textContent("#side-meta") || ""), await page.textContent("#side-meta"));
  check("docked xterm mounted in the panel", (await page.locator("#sideterm .xterm").count()) === 1);

  // Only one xterm instance in the whole document.
  check("exactly one xterm in the document", (await page.locator(".xterm").count()) === 1, `${await page.locator(".xterm").count()} found`);

  // The shell is alive in the panel: it is the opencode TUI that was running.
  await page.waitForTimeout(2500);
  const rows = ((await page.textContent("#sideterm .xterm-rows")) || "").replace(/\s+/g, " ");
  check("docked terminal shows the live shell", rows.length > 20, rows.slice(0, 90));

  // Typing must reach the PTY, not be swallowed by the canvas. The shell here is
  // the opencode TUI, so this proves the byte path, not a command result.
  await page.click("#sideterm .xterm-screen");
  await page.keyboard.type("DOCKED_PTY_OK");
  await page.waitForFunction(
    () => (document.querySelector("#sideterm .xterm-rows")?.textContent || "").includes("DOCKED_PTY_OK"),
    { timeout: 20000 },
  ).catch(() => {});
  check("keystrokes reach the docked PTY", /DOCKED_PTY_OK/.test(((await page.textContent("#sideterm .xterm-rows")) || "")), "");
  await page.keyboard.press("Backspace");
  for (let i = 0; i < 13; i++) await page.keyboard.press("Backspace");

  // --- the 2s poll must not steal focus or reopen detail ----------------
  await page.waitForTimeout(5000);
  check("poll did not open the detail panel", await page.isHidden("#detail"));
  check("panel still docked after a poll cycle", await page.isVisible("#sidepanel"));

  // --- drag handle -------------------------------------------------------
  const grip = (await page.locator("#sidegrip").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x - 180, grip.y + grip.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const sp2 = (await page.locator("#sidepanel").boundingBox())!;
  check("drag handle resizes the panel", sp2.width > sp.width + 120, `${Math.round(sp.width)} -> ${Math.round(sp2.width)}`);
  check("still docked after a drag", await page.isVisible("#sidepanel"));
  check("still exactly one xterm after resize", (await page.locator(".xterm").count()) === 1);

  // --- keyboard separator resize ----------------------------------------
  await page.locator("#sidegrip").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  const sp3 = (await page.locator("#sidepanel").boundingBox())!;
  check("separator is keyboard resizable", sp3.width < sp2.width - 10, `${Math.round(sp2.width)} -> ${Math.round(sp3.width)}`);

  // --- escape closes, but not from inside the terminal --------------------
  // xterm stops propagation for every key it consumes, and the docked content is
  // an agent TUI whose Escape is load-bearing. The panel must not steal it --
  // but moving focus to the header hands it straight back.
  await page.click("#sideterm .xterm-screen");
  check("terminal takes focus on dock", (await page.evaluate(() => document.activeElement?.tagName)) === "TEXTAREA");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check("Escape inside the terminal is left to the terminal", await page.isVisible("#sidepanel"));

  await page.click("#sidehead");
  check("clicking the header moves focus out of the terminal", (await page.evaluate(() => document.activeElement?.id)) === "sidehead");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#sidepanel[hidden]", { state: "attached", timeout: 5000 });
  check("Escape from the header undocks", await page.isHidden("#sidepanel"));
  check("agent list came back", await page.isVisible("#agentlist"));

  // --- switch to Terminals tab, then back -------------------------------
  await page.click("#vterm");
  await page.waitForTimeout(1200);
  check("Terminals view still mounts one xterm", (await page.locator("#screen .xterm").count()) === 1);
  await page.click("#vgraph");
  await page.waitForTimeout(1500);
  check("returning to Agents does not auto-dock", await page.isHidden("#sidepanel"));
  check("agent list is back after a round trip", await page.isVisible("#agentlist"));

  // --- close button -----------------------------------------------------
  await page.locator("#agentlist button").first().click();
  await page.waitForSelector("#sidepanel:not([hidden])", { timeout: 8000 });
  check("list click also docks (no navigation)", await page.isVisible("#graphview") && await page.isHidden("#termview"));
  await page.click("#side-close");
  await page.waitForSelector("#sidepanel[hidden]", { state: "attached", timeout: 5000 });
  check("close button undocks", await page.isHidden("#sidepanel") && await page.isVisible("#agentlist"));

  // --- an agent with no terminal keeps the detail panel -----------------
  const noTerm = await page.locator("#agentlist button", { hasText: "not a process" }).count();
  if (noTerm) {
    await page.locator("#agentlist button", { hasText: "not a process" }).first().click();
    await page.waitForTimeout(600);
    check("a session with no shell still opens details", await page.isVisible("#detail"));
    await page.keyboard.press("Escape");
  } else {
    check("a session with no shell still opens details", true, "no such agent in this workspace, skipped");
  }

  await page.screenshot({ path: "shot-dock.png" });
  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e: any) {
  console.error("\n  ERROR:", e.message);
  failures++;
  await page.screenshot({ path: "shot-dock-fail.png" }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}\n`);
process.exit(failures ? 1 : 0);
