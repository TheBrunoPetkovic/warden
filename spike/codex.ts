import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Codex spike — verifies the two capabilities the adapter depends on:
 *   1. `codex exec --json` emits a parseable JSONL event stream
 *   2. `codex exec resume <thread_id> "msg"` continues an existing session
 *
 * Approval UX is NOT here: `exec` has no approval handshake (no TTY).
 * That path goes through `codex app-server` — see docs/spike-findings.md.
 */

const dir = mkdtempSync(join(tmpdir(), "warden-codex-"));
const log = (...a: unknown[]) => console.log(...a);

type Ev = { type: string; thread_id?: string; item?: Record<string, unknown>; usage?: Record<string, number> };

function runCodex(args: string[]): Promise<{ evs: Ev[]; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("codex", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      // stdout carries a human line before the JSONL starts; keep only `{`-prefixed lines.
      const evs = out
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .flatMap((l) => {
          try { return [JSON.parse(l)]; } catch { return []; }
        });
      log(`  exit=${code} jsonl_lines=${evs.length}`);
      resolve({ evs, stderr: err });
    });
  });
}

async function main() {
  log("sandbox:", dir);
  log("\n→ 1. exec --json (does the event stream parse?)");
  const first = await runCodex([
    "exec", "--json", "--skip-git-repo-check", "-C", ".", "-s", "workspace-write",
    "Run the shell command: echo WARDEN_CODEX_PROBE . Then reply with just OK.",
  ]);

  const counts = new Map<string, number>();
  for (const e of first.evs) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  log("  event types:");
  for (const [k, v] of counts) log(`    ${v}x ${k}`);

  const thread = first.evs.find((e) => e.type === "thread.started")?.thread_id;
  const exec = first.evs.find((e) => e.type === "item.completed" && e.item?.type === "command_execution")?.item as any;
  log(`  thread_id:  ${thread}`);
  log(`  ran:        ${exec?.command}`);
  log(`  exit_code:  ${exec?.exit_code}`);
  log(`  output:     ${JSON.stringify(exec?.aggregated_output)}`);
  log(`  usage:      ${JSON.stringify(first.evs.find((e) => e.type === "turn.completed")?.usage)}`);

  if (first.stderr.trim()) {
    log("  stderr noise (expected, not agent output):");
    for (const line of first.stderr.trim().split("\n").slice(0, 2)) log(`    ${line.slice(0, 100)}`);
  }

  if (!thread) {
    console.error("\nFAILED: no thread.started, cannot test resume");
    process.exit(1);
  }

  log("\n→ 2. exec resume (can we send a follow-up to an existing session?)");
  const second = await runCodex([
    "exec", "resume", thread, "--json", "--skip-git-repo-check",
    "What was the exact output of the command you just ran? Reply with only the value.",
  ]);
  const reply = second.evs.filter((e) => e.item?.type === "agent_message").pop() as any;
  log(`  agent recalled: ${JSON.stringify(reply?.item?.text)}`);
  log(`  turn completed: ${second.evs.some((e) => e.type === "turn.completed")}`);

  const recalled = String(reply?.item?.text ?? "").includes("WARDEN_CODEX_PROBE");
  log(`\n${recalled ? "PASS" : "FAIL"} — resume preserved session context`);

  rmSync(dir, { recursive: true, force: true });
  process.exit(recalled ? 0 : 1);
}

main().catch((e) => { console.error("SPIKE FAILED:", e); process.exit(1); });
