/**
 * Terminal splash for Warden.
 *
 * Hand-rolled rather than pulled from figlet/boxen/chalk: the whole thing is a
 * few hundred bytes of ANSI, and the project is a local dev tool that should
 * install and run without a dependency tree for a greeting.
 */

const esc = (code: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? code : "");
const bold = (s: string) => esc("[1m") + s + esc("[22m");
const dim = (s: string) => esc("[2m") + s + esc("[22m");
const cyan = (s: string) => esc("[36m") + s + esc("[39m");

/**
 * W A R D E N in 5x5-ish block capitals, one string per row.
 * Half-block corners keep the silhouette from looking like a plain rectangle.
 */
const WORDMARK = [
  "██╗    ██╗ █████╗ ██████╗ ██████╗ ███████╗███╗   ██╗",
  "██║    ██║██╔══██╗██╔══██╗██╔══██╗██╔════╝████╗  ██║",
  "██║ █╗ ██║███████║██████╔╝██║  ██║█████╗  ██╔██╗ ██║",
  "██║███╗██║██╔══██║██╔══██╗██║  ██║██╔══╝  ██║╚██╗██║",
  "╚███╔███╔╝██║  ██║██║  ██║██████╔╝███████╗██║ ╚████║",
  " ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝",
];

const TAGLINE = "control room for your coding agents";

const RULES = {
  topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
  h: "─", v: "│", teeDown: "┬", teeUp: "┴", teeRight: "├", teeLeft: "┤",
};

/** Longest visible width, ignoring ANSI escapes. */
const width = (s: string) => s.replace(/\[\d+m/g, "").length;

export function renderBanner(info: {
  port: number;
  workspaceCount: number;
  runtimes: string[];
}) {
  const art = WORDMARK.map(cyan);
  const lines: string[] = [];
  const inner = Math.max(width(WORDMARK[0]), 56);

  lines.push("");
  lines.push(dim(RULES.topLeft + RULES.h.repeat(inner + 2) + RULES.topRight));
  for (const row of art) lines.push(dim(RULES.v) + " " + pad(row, inner) + " " + dim(RULES.v));
  lines.push(
    dim(RULES.teeRight + RULES.h.repeat(inner + 2) + RULES.teeLeft) +
      `  ${bold(cyan(TAGLINE))}`,
  );
  lines.push(dim(RULES.bottomLeft + RULES.h.repeat(inner + 2) + RULES.bottomRight));
  lines.push("");

  const label = (s: string) => dim(s.padEnd(9));
  const rows: [string, string][] = [
    ["url", bold(`http://127.0.0.1:${info.port}`)],
    ["runtimes", info.runtimes.join(", ") || "none"],
    ["workspaces", String(info.workspaceCount)],
  ];
  const padTo = Math.max(...rows.map(([l]) => width(l)));
  for (const [l, v] of rows) lines.push(`  ${label(l)}${bold(pad(v, padTo - width(l)))}`);
  lines.push("");
  return lines.join("\n");
}

function pad(s: string, n: number) {
  const fill = Math.max(0, n - width(s));
  return s + " ".repeat(fill);
}
