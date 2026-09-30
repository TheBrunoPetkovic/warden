/**
 * Force-directed layout for the agent graph.
 *
 * Plain Euler integration with a Barnes-Hut-free O(n^2) repulsion: a few hundred
 * nodes is far below the point where quadtree acceleration would pay for its
 * complexity. Kept deterministic (seeded jitter, fixed iteration order) so the
 * graph does not jitter on every poll.
 */

export interface Point { x: number; y: number; vx: number; vy: number; }

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  depth: number;
}

export interface LayoutEdge { from: string; to: string; }

const ITERATIONS = 220;

export function layout(
  nodes: { id: string; parentId?: string; weight?: number }[],
  edges: LayoutEdge[],
  width: number,
  height: number,
): LayoutNode[] {
  const n = nodes.length;
  if (!n) return [];

  const index = new Map(nodes.map((d, i) => [d.id, i]));
  const childCount = new Map<string, number>();
  for (const d of nodes) {
    if (d.parentId) childCount.set(d.parentId, (childCount.get(d.parentId) ?? 0) + 1);
  }

  // Depth from the root drives the vertical axis: agents read as a tree.
  const depth = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let d = 0;
    let cur = nodes[i];
    const guard = new Set<string>();
    while (cur?.parentId && index.has(cur.parentId) && !guard.has(cur.parentId)) {
      guard.add(cur.parentId);
      cur = nodes[index.get(cur.parentId)!];
      d++;
      if (d > 24) break;
    }
    depth[i] = d;
  }

  // Seeded pseudo-random: stable positions across reloads without a real RNG dep.
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };

  const out: LayoutNode[] = nodes.map((d, i) => {
    const layer = depth[i];
    const spread = (layer / 3) * (height * 0.22);
    return {
      id: d.id,
      x: width * (0.14 + rand() * 0.72),
      y: Math.min(height - 40, 60 + spread + rand() * 90),
      vx: 0,
      vy: 0,
      radius: 7 + Math.min(9, (childCount.get(d.id) ?? 0) * 1.4),
      depth: layer,
    };
  });

  const links = edges
    .map(e => [index.get(e.from), index.get(e.to)] as const)
    .filter(([a, b]) => a != null && b != null) as [number, number][];

  const K = Math.sqrt((width * height) / Math.max(n, 1)) * 0.62;
  const centreX = width / 2;
  const centreY = height / 2;

  for (let step = 0; step < ITERATIONS; step++) {
    const alpha = 1 - step / ITERATIONS;

    // repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = out[i].x - out[j].x;
        let dy = out[i].y - out[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (rand() - 0.5) * 0.4; dy = (rand() - 0.5) * 0.4; d2 = 0.16; }
        const d = Math.sqrt(d2);
        const f = (K * K) / d2;
        const ux = dx / d, uy = dy / d;
        out[i].vx += ux * f; out[i].vy += uy * f;
        out[j].vx -= ux * f; out[j].vy -= uy * f;
      }
    }

    // springs along parent links
    for (const [a, b] of links) {
      const dx = out[b].x - out[a].x;
      const dy = out[b].y - out[a].y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (d * d) / K / 9;
      const ux = dx / d, uy = dy / d;
      out[b].vx -= ux * f; out[b].vy -= uy * f;
      out[a].vx += ux * f; out[a].vy += uy * f;
    }

    // gravity, plus a nudge that keeps deeper layers lower on screen
    for (let i = 0; i < n; i++) {
      out[i].vx += (centreX - out[i].x) * 0.012;
      out[i].vy += (centreY - out[i].y) * 0.012 + out[i].depth * 0.55;
    }

    // integrate with damping
    for (let i = 0; i < n; i++) {
      const node = out[i];
      node.vx *= 0.82; node.vy *= 0.82;
      node.x += Math.max(-24, Math.min(24, node.vx * alpha));
      node.y += Math.max(-24, Math.min(24, node.vy * alpha));
      node.x = Math.max(node.radius + 8, Math.min(width - node.radius - 8, node.x));
      node.y = Math.max(node.radius + 8, Math.min(height - node.radius - 8, node.y));
    }
  }

  return out;
}
