import { Diagram, DiagramNode, shapeOf } from './model';
import { measure, wrap } from './text';

const GAP_X = 82;
const GAP_Y = 34;
const PAD = 24;

/** 根据文字与端口数量把节点尺寸调到刚好合适 */
function fitNode(d: Diagram, nd: DiagramNode): void {
  if (nd.type === 'init' || nd.type === 'final' || nd.type === 'junction') return;
  const shape = shapeOf(nd.type, d.kind);
  const baseW = nd.size?.[0] ?? shape.w;
  const baseH = nd.size?.[1] ?? shape.h;
  const fs = 13;
  const avail = Math.max(72, baseW - 28);
  const lines = wrap(nd.label, avail, fs);
  const widest = Math.max(0, ...lines.map((l) => measure(l, fs)));
  const subWidest = nd.sub ? measure(nd.sub, 11) : 0;
  const portW = maxPortLabel(nd);
  const needW = Math.max(widest + 28, subWidest + 24, portW + 20, 56);
  nd.w = Math.min(Math.max(baseW, needW), Math.max(baseW, 300));
  const lineH = 17;
  const subH = nd.sub ? 15 : 0;
  const needH = Math.max(baseH, lines.length * lineH + subH + 26);
  nd.h = Math.min(needH, 220);
}

function maxPortLabel(nd: DiagramNode): number {
  if (!nd.ports.length) return 0;
  const left = nd.ports.filter((p) => p.side === 'l').map((p) => measure(p.name, 10));
  const right = nd.ports.filter((p) => p.side === 'r').map((p) => measure(p.name, 10));
  const l = left.length ? Math.max(...left) : 0;
  const r = right.length ? Math.max(...right) : 0;
  return l + r + 34;
}

function isContainer(nd: DiagramNode): boolean {
  return nd.type === 'group' || nd.type === 'frame';
}

export function layout(d: Diagram): void {
  if (d.kind === 'timing') return;
  const nodes = d.nodes.filter((n) => !isContainer(n));
  if (!nodes.length) {
    for (const g of d.nodes) applyPos(g);
    return;
  }
  for (const nd of nodes) fitNode(d, nd);

  const strategy = d.options.layout;
  const manual = strategy === 'manual' || nodes.every((n) => n.pos);
  if (manual) {
    for (const nd of nodes) {
      const [x, y] = nd.pos ?? [0, 0];
      nd.x = x;
      nd.y = y;
    }
  } else if (d.kind === 'fsm' && (strategy === 'auto' || strategy === 'circular')) {
    circular(d, nodes);
    for (const nd of nodes) applyPos(nd);
  } else if (strategy === 'grid') {
    gridLayout(nodes, d.options.nodeSpacing);
    for (const nd of nodes) applyPos(nd);
  } else {
    // layered / sugiyama / force / auto 都走分层布局（sugiyama 即分层，force 用分层近似）
    layered(d, nodes);
    for (const nd of nodes) applyPos(nd);
  }

  for (const g of d.nodes) {
    if (!isContainer(g)) continue;
    const kids = (g.children ?? [])
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is DiagramNode => !!n);
    if (kids.length) {
      const topPad = g.type === 'frame' && g.titlePos !== 'br' ? PAD + 8 : PAD;
      const x0 = Math.min(...kids.map((k) => k.x)) - PAD;
      const y0 = Math.min(...kids.map((k) => k.y)) - topPad - (g.type === 'group' ? 16 : 0);
      const x1 = Math.max(...kids.map((k) => k.x + k.w)) + PAD;
      const y1 = Math.max(...kids.map((k) => k.y + k.h)) + PAD;
      g.x = x0;
      g.y = y0;
      g.w = x1 - x0;
      g.h = y1 - y0;
    } else {
      const [x, y] = g.pos ?? [0, 0];
      g.x = x;
      g.y = y;
      g.w = g.size?.[0] ?? 280;
      g.h = g.size?.[1] ?? 170;
    }
  }
}

function applyPos(nd: DiagramNode): void {
  if (nd.pos) {
    nd.x = nd.pos[0];
    nd.y = nd.pos[1];
  }
}

/** 网格布局：按节点数开方排成方阵，格距可用 nodeSpacing 调 */
function gridLayout(nodes: DiagramNode[], spacing?: number): void {
  if (!nodes.length) return;
  const gap = spacing && spacing > 0 ? spacing : GAP_X;
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const rows = Math.ceil(nodes.length / cols);
  const colW = Math.max(...nodes.map((n) => n.w)) + gap;
  const rowH = Math.max(...nodes.map((n) => n.h)) + gap;
  nodes.forEach((nd, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    nd.x = c * colW + (colW - nd.w) / 2;
    nd.y = r * rowH + (rowH - nd.h) / 2;
  });
  void rows;
}

/** 从圆心指向节点的单位向量（用于把 init / final 摆到圆周外侧） */
function radialUnit(cx: number, cy: number, nd: DiagramNode): [number, number] {
  const dx = nd.x + nd.w / 2 - cx;
  const dy = nd.y + nd.h / 2 - cy;
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/**
 * 环形布局：沿转移关系做一次遍历，把状态按"走一遍"的顺序摆在圆周上，
 * 这样相邻的转移就是短弧，而不是横穿整个图的折线。
 * init / final 贴到相关状态的外侧。
 */
function circular(d: Diagram, nodes: DiagramNode[]): void {
  const initNodes = nodes.filter((n) => n.type === 'init');
  const finalNodes = nodes.filter((n) => n.type === 'final');
  const states = nodes.filter((n) => n.type !== 'init' && n.type !== 'final');
  if (!states.length) {
    layered(d, nodes);
    return;
  }

  const ids = new Set(states.map((n) => n.id));
  const outAdj = new Map<string, string[]>();
  const inAdj = new Map<string, string[]>();
  for (const n of states) {
    outAdj.set(n.id, []);
    inAdj.set(n.id, []);
  }
  for (const e of d.edges) {
    if (e.from.node === e.to.node) continue;
    if (ids.has(e.from.node) && ids.has(e.to.node)) {
      outAdj.get(e.from.node)!.push(e.to.node);
      inAdj.get(e.to.node)!.push(e.from.node);
    }
  }

  // 入口状态：init 指向的那个；没有就用无入边的；再不行取第一个
  let entry = '';
  const fromInit = d.edges.find((e) => initNodes.some((i) => i.id === e.from.node) && ids.has(e.to.node));
  if (fromInit) entry = fromInit.to.node;
  if (!entry) entry = states.find((s) => inAdj.get(s.id)!.length === 0)?.id ?? states[0].id;

  // 广度优先遍历出摆放顺序
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || !ids.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const nxt of outAdj.get(id) ?? []) if (!seen.has(nxt)) queue.push(nxt);
  }
  for (const s of states) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    order.push(s.id);
  }

  const byId = new Map(states.map((s) => [s.id, s]));
  const ordered = order.map((id) => byId.get(id)).filter((n): n is DiagramNode => !!n);
  const count = ordered.length;

  const span = ordered.reduce((s, n) => s + Math.max(n.w, n.h) + 46, 0);
  const radius = Math.max(count <= 2 ? 108 : 158, span / (2 * Math.PI));
  const cx = radius + 90;
  const cy = radius + 90;

  ordered.forEach((nd, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    nd.x = cx + Math.cos(a) * radius - nd.w / 2;
    nd.y = cy + Math.sin(a) * radius - nd.h / 2;
  });

  const entryNode = ordered[0];
  initNodes.forEach((nd, k) => {
    const [ux, uy] = radialUnit(cx, cy, entryNode);
    const dist = Math.max(entryNode.w, entryNode.h) / 2 + 46 + k * 34;
    nd.x = entryNode.x + entryNode.w / 2 + ux * dist - nd.w / 2;
    nd.y = entryNode.y + entryNode.h / 2 + uy * dist - nd.h / 2;
  });

  const incomingFinal = d.edges.find((e) => finalNodes.some((f) => f.id === e.to.node) && ids.has(e.from.node));
  const anchorState = (incomingFinal && byId.get(incomingFinal.from.node)) || ordered[ordered.length - 1];
  finalNodes.forEach((nd, k) => {
    const [ux, uy] = radialUnit(cx, cy, anchorState);
    const dist = Math.max(anchorState.w, anchorState.h) / 2 + 56 + k * 40;
    nd.x = anchorState.x + anchorState.w / 2 + ux * dist - nd.w / 2;
    nd.y = anchorState.y + anchorState.h / 2 + uy * dist - nd.h / 2;
  });
}

function layered(d: Diagram, nodes: DiagramNode[]): void {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const n of nodes) {
    out.set(n.id, []);
    inc.set(n.id, []);
  }
  const edges = d.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node) && e.from.node !== e.to.node);
  for (const e of edges) {
    out.get(e.from.node)!.push(e.to.node);
    inc.get(e.to.node)!.push(e.from.node);
  }

  // 断环：DFS 标记回边，回边不参与分层
  const back = new Set<string>();
  const state = new Map<string, number>();
  const dfs = (id: string) => {
    state.set(id, 1);
    for (const nxt of out.get(id) ?? []) {
      const s = state.get(nxt) ?? 0;
      if (s === 1) back.add(id + '>' + nxt);
      else if (s === 0) dfs(nxt);
    }
    state.set(id, 2);
  };
  for (const n of nodes) if (!state.get(n.id)) dfs(n.id);

  const rank = new Map<string, number>();
  const fwd = edges.filter((e) => !back.has(e.from.node + '>' + e.to.node));
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, 0);
  for (const e of fwd) indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const id of queue) rank.set(id, 0);
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const id = queue.shift()!;
    const r = rank.get(id) ?? 0;
    for (const nxt of out.get(id) ?? []) {
      if (back.has(id + '>' + nxt)) continue;
      rank.set(nxt, Math.max(rank.get(nxt) ?? 0, r + 1));
      const left = (indeg.get(nxt) ?? 1) - 1;
      indeg.set(nxt, left);
      if (left === 0) queue.push(nxt);
    }
  }
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, 0);

  const byRank = new Map<number, DiagramNode[]>();
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(n);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const layers = ranks.map((r) => byRank.get(r)!);

  // 重心法排序，减少交叉
  const indexOf = new Map<string, number>();
  layers.forEach((layer) => layer.forEach((n, i) => indexOf.set(n.id, i)));
  for (let pass = 0; pass < 4; pass++) {
    const forward = pass % 2 === 0;
    const order = forward ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
    for (const li of order) {
      const layer = layers[li];
      const rel = forward ? inc : out;
      const nums = new Map<string, number>();
      layer.forEach((n, i) => {
        const prev = (rel.get(n.id) ?? []).filter((p) => indexOf.has(p));
        if (!prev.length) {
          nums.set(n.id, i);
          return;
        }
        const avg = prev.reduce((s, p) => s + (indexOf.get(p) ?? 0), 0) / prev.length;
        nums.set(n.id, avg);
      });
      layer.sort((a, b) => (nums.get(a.id) ?? 0) - (nums.get(b.id) ?? 0));
      layer.forEach((n, i) => indexOf.set(n.id, i));
    }
  }

  const dir = d.options.direction;
  const horiz = dir === 'LR' || dir === 'RL';
  const reverse = dir === 'RL' || dir === 'BT';
  const primary = (a: number, b: number) => (horiz ? a : b);

  // 主轴坐标
  let cursor = 0;
  const mainSpan = (n: { w: number; h: number }) => (horiz ? n.w : n.h);
  const layerSpan: number[] = layers.map((layer) => Math.max(...layer.map(mainSpan)));
  layers.forEach((layer, li) => {
    for (const n of layer) {
      const offset = (layerSpan[li] - mainSpan(n)) / 2;
      if (horiz) n.x = cursor + offset;
      else n.y = cursor + offset;
    }
    cursor += layerSpan[li] + (horiz ? GAP_X : GAP_Y);
  });

  // RL / BT：把主轴坐标镜像翻转，让数据流从右到左 / 从下到上
  if (reverse) {
    const totalMain = cursor - (horiz ? GAP_X : GAP_Y);
    for (const n of nodes) {
      if (horiz) n.x = totalMain - n.x - n.w;
      else n.y = totalMain - n.y - n.h;
    }
  }

  // 交叉轴坐标
  const crossSpan = layers.map((layer) =>
    layer.reduce((s, n) => s + (horiz ? n.h : n.w), 0) + Math.max(0, layer.length - 1) * (horiz ? GAP_Y : GAP_X),
  );
  const maxCross = Math.max(...crossSpan);
  layers.forEach((layer, li) => {
    let c = (maxCross - crossSpan[li]) / 2;
    for (const n of layer) {
      if (horiz) n.y = c;
      else n.x = c;
      c += (horiz ? n.h : n.w) + (horiz ? GAP_Y : GAP_X);
    }
  });
}
