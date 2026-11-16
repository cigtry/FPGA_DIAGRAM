import { Diagram, DiagramEdge, DiagramNode, EdgeRoute, Side, TimingPanel } from './model';
import { Palette, edgeColor } from './theme';
import { FONT, MONO, esc, measure, n, wrap } from './text';
import { layout } from './layout';

export interface RenderOptions {
  theme: Palette;
  selection?: string[];
  selEdges?: string[];
  handles?: boolean;
  anchorsOn?: string | null;
  padding?: number;
  /** 画布模式：带命中属性，便于交互 */
  interactive?: boolean;
  /** 拖放时高亮的连线（插入落点提示） */
  dropEdge?: string;
  /** 内部用：已放好的标签矩形，后续标签避让它们 */
  labelBoxes?: { x: number; y: number; w: number; h: number }[];
  /** 时序图里被选中的信号行 */
  selRow?: { panel: number; row: number } | null;
}

export interface RenderResult {
  body: string;
  width: number;
  height: number;
}

interface Pt {
  x: number;
  y: number;
}

interface Anchor extends Pt {
  side: Side;
}

const PAD_DEFAULT = 40;

export function render(d: Diagram, opt: RenderOptions): RenderResult {
  const p = opt.theme;
  const pad = opt.padding ?? PAD_DEFAULT;
  layout(d);
  const titleH = d.title ? 46 : 0;

  const bounds = contentBounds(d);
  const dx = pad - bounds.x;
  const dy = pad + titleH - bounds.y;
  const width = Math.max(120, bounds.w + pad * 2);
  const height = Math.max(80, bounds.h + pad * 2 + titleH);

  const parts: string[] = [];
  parts.push(markerDefs(p));

  if (d.title) {
    parts.push(
      `<text x="${n(pad)}" y="${n(pad + 4)}" font-family="${FONT}" font-size="15" font-weight="500" fill="${p.title}">${esc(d.title)}</text>`,
    );
  }

  if (d.kind === 'timing') {
    parts.push(`<g transform="translate(${n(dx)},${n(dy)})">${timingBody(d, p, opt)}</g>`);
    return { body: parts.join(''), width, height };
  }

  const g: string[] = [];
  opt.labelBoxes = [];
  for (const e of d.edges) g.push(edgeSvg(d, e, p, opt));
  // 外层容器先画、内层后画，否则模块底色会把里面的分组框盖掉
  const depth = containmentDepth(d);
  const ordered = [...d.nodes].sort(
    (a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || b.w * b.h - a.w * a.h,
  );
  for (const nd of ordered) {
    if (nd.type === 'group') g.push(groupSvg(nd, p, opt));
    else if (nd.type === 'frame') g.push(frameSvg(d, nd, p, opt));
    else g.push(nodeSvg(d, nd, p, opt));
  }

  if (opt.anchorsOn) {
    const nd = d.nodes.find((x) => x.id === opt.anchorsOn);
    if (nd) g.push(anchorDots(nd, p, opt));
  }

  parts.push(`<g transform="translate(${n(dx)},${n(dy)})">${g.join('')}</g>`);
  return { body: parts.join(''), width, height };
}

/** 一个节点被多少更大的矩形完整包住——用来决定绘制层级 */
function containmentDepth(d: Diagram): Map<string, number> {
  const m = new Map<string, number>();
  for (const nd of d.nodes) {
    let depth = 0;
    for (const o of d.nodes) {
      if (o === nd) continue;
      if (o.w >= nd.w && o.h >= nd.h && o.x <= nd.x && o.y <= nd.y && o.x + o.w >= nd.x + nd.w && o.y + o.h >= nd.y + nd.h) {
        depth += 1;
      }
    }
    m.set(nd.id, depth);
  }
  return m;
}

function contentBounds(d: Diagram): { x: number; y: number; w: number; h: number } {
  if (d.kind === 'timing') {
    return { x: 0, y: 0, w: timingWidth(d), h: timingHeight(d) };
  }
  if (!d.nodes.length) return { x: 0, y: 0, w: 240, h: 140 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const nd of d.nodes) {
    let left = nd.x;
    let right = nd.x + nd.w;
    if (nd.type === 'frame') {
      for (const port of nd.ports) {
        if (port.side !== 'l' && port.side !== 'r') continue;
        const span = measure(port.name, 9.5) + 34;
        if (port.side === 'l') left = Math.min(left, nd.x - span);
        else right = Math.max(right, nd.x + nd.w + span);
      }
    }
    x0 = Math.min(x0, left);
    y0 = Math.min(y0, nd.y - (nd.type === 'group' ? 16 : 0));
    x1 = Math.max(x1, right);
    y1 = Math.max(y1, nd.y + nd.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function markerDefs(p: Palette): string {
  const mk = (id: string, color: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9.2" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse"><path d="M0.6,1.2 L9.6,5 L0.6,8.8 z" fill="${color}"/></marker>`;
  return (
    `<defs>` +
    mk('arw-wire', p.wire) +
    mk('arw-bus', p.bus) +
    mk('arw-clock', p.clock) +
    mk('arw-ctrl', p.ctrl) +
    mk('arw-accent', p.accent) +
    `</defs>`
  );
}

// ---------------------------------------------------------------- nodes

function textBlock(
  nd: DiagramNode,
  p: Palette,
  opts: { align?: 'center' | 'left'; size?: number; color?: string; x?: number; yTop?: number; w?: number } = {},
): string {
  const size = opts.size ?? 13;
  const color = opts.color ?? p.text;
  const maxW = (opts.w ?? nd.w) - 24;
  const lines = wrap(nd.label, maxW, size);
  const subs = nd.sub ? wrap(nd.sub, maxW, 11) : [];
  const lineH = size + 4;
  const subH = 13;
  const total = lines.length * lineH + (subs.length ? subs.length * subH + 3 : 0);
  const cx = opts.x ?? nd.x + nd.w / 2;
  const startY = (opts.yTop ?? nd.y + (nd.h - total) / 2) + size * 0.92;
  const anchor = (opts.align ?? 'center') === 'center' ? 'middle' : 'start';
  const out: string[] = [];
  lines.forEach((line, i) => {
    out.push(
      `<text x="${n(cx)}" y="${n(startY + i * lineH)}" text-anchor="${anchor}" font-family="${FONT}" font-size="${size}" fill="${color}">${esc(line)}</text>`,
    );
  });
  subs.forEach((line, i) => {
    out.push(
      `<text x="${n(cx)}" y="${n(startY + lines.length * lineH + i * subH)}" text-anchor="${anchor}" font-family="${FONT}" font-size="11" fill="${p.textDim}">${esc(line)}</text>`,
    );
  });
  return out.join('');
}

function shapeFill(nd: DiagramNode, p: Palette): string {
  if (nd.type === 'note') return p.noteFill;
  if (nd.type === 'io' || nd.type === 'init') return p.nodeFillAlt;
  return p.nodeFill;
}

function nodeSvg(d: Diagram, nd: DiagramNode, p: Palette, opt: RenderOptions): string {
  const sel = !!opt.selection?.includes(nd.id);
  const hit = opt.interactive ? ` data-node="${esc(nd.id)}" class="fd-node"` : '';
  const body: string[] = [];
  const stroke = sel ? p.accent : nd.type === 'note' ? p.noteStroke : p.nodeStroke;
  const sw = sel ? 1.9 : 1.35;
  const fill = shapeFill(nd, p);
  const x = nd.x;
  const y = nd.y;
  const w = nd.w;
  const h = nd.h;

  const rect = (extra = '') =>
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${extra}/>`;
  const hitRect = opt.interactive
    ? `<rect x="${n(x - 2)}" y="${n(y - 2)}" width="${n(w + 4)}" height="${n(h + 4)}" fill="transparent"/>`
    : '';

  switch (nd.type) {
    case 'adder':
    case 'mult': {
      body.push(rect());
      const bw = 24;
      body.push(`<line x1="${n(x + bw)}" y1="${n(y)}" x2="${n(x + bw)}" y2="${n(y + h)}" stroke="${stroke}" stroke-width="${sw}"/>`);
      const sym = nd.type === 'adder' ? '+' : '×';
      body.push(
        `<text x="${n(x + bw / 2)}" y="${n(y + h / 2 + 6)}" text-anchor="middle" font-family="${FONT}" font-size="15" fill="${p.text}">${sym}</text>`,
      );
      body.push(textBlock({ ...nd, sub: nd.sub }, p, { x: x + bw + (w - bw) / 2, w: w - bw }));
      break;
    }
    case 'mux': {
      const inset = Math.min(34, w * 0.3);
      body.push(
        `<path d="M${n(x)},${n(y)} L${n(x + w - inset)},${n(y)} L${n(x + w)},${n(y + h)} L${n(x)},${n(y + h)} Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
      );
      body.push(textBlock(nd, p, { x: x + (w - inset) / 2 + 4 }));
      break;
    }
    case 'fifo': {
      body.push(rect());
      body.push(
        `<path d="M${n(x + 10)},${n(y + 12)} L${n(x + 10)},${n(y + h - 12)} M${n(x + 15)},${n(y + 12)} L${n(x + 15)},${n(y + h - 12)}" stroke="${stroke}" stroke-width="1.1" opacity="0.65"/>`,
      );
      body.push(
        `<path d="M${n(x + w - 15)},${n(y + 12)} L${n(x + w - 15)},${n(y + h - 12)} M${n(x + w - 10)},${n(y + 12)} L${n(x + w - 10)},${n(y + h - 12)}" stroke="${stroke}" stroke-width="1.1" opacity="0.65"/>`,
      );
      body.push(textBlock(nd, p));
      break;
    }
    case 'ram': {
      body.push(rect());
      body.push(`<line x1="${n(x + 20)}" y1="${n(y)}" x2="${n(x + 20)}" y2="${n(y + h)}" stroke="${stroke}" stroke-width="${sw}" opacity="0.8"/>`);
      for (let i = 1; i <= 3; i++) {
        const ly = y + (h * i) / 4;
        body.push(
          `<line x1="${n(x + 5)}" y1="${n(ly)}" x2="${n(x + 15)}" y2="${n(ly)}" stroke="${stroke}" stroke-width="1" opacity="0.55"/>`,
        );
      }
      body.push(textBlock(nd, p, { x: x + 20 + (w - 20) / 2, w: w - 20 }));
      break;
    }
    case 'clock': {
      body.push(rect());
      const gx = x + 12;
      const gy = y + 14;
      const gw = Math.min(w - 24, 56);
      const amp = 9;
      body.push(
        `<path d="M${n(gx)},${n(gy + amp)} h${n(gw * 0.18)} v${n(-amp)} h${n(gw * 0.32)} v${n(amp)} h${n(gw * 0.32)} v${n(-amp)} h${n(gw * 0.18)}" fill="none" stroke="${p.clock}" stroke-width="1.3" stroke-linejoin="round"/>`,
      );
      body.push(textBlock({ ...nd, label: nd.label }, p, { yTop: y + 26 }));
      break;
    }
    case 'io': {
      body.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
      body.push(textBlock(nd, p));
      break;
    }
    case 'note': {
      const fold = 14;
      body.push(
        `<path d="M${n(x)},${n(y)} L${n(x + w - fold)},${n(y)} L${n(x + w)},${n(y + fold)} L${n(x + w)},${n(y + h)} L${n(x)},${n(y + h)} Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
      );
      body.push(`<path d="M${n(x + w - fold)},${n(y)} L${n(x + w - fold)},${n(y + fold)} L${n(x + w)},${n(y + fold)}" fill="none" stroke="${stroke}" stroke-width="1.1"/>`);
      body.push(
        `<text x="${n(x + 12)}" y="${n(y + 20)}" font-family="${FONT}" font-size="12" fill="${p.text}">${esc(wrap(nd.label, w - 24, 12)[0] ?? '')}</text>`,
      );
      break;
    }
    case 'diamond': {
      body.push(
        `<path d="M${n(x + w / 2)},${n(y)} L${n(x + w)},${n(y + h / 2)} L${n(x + w / 2)},${n(y + h)} L${n(x)},${n(y + h / 2)} Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
      );
      body.push(textBlock(nd, p, { w: w - 26 }));
      break;
    }
    case 'init': {
      const r = Math.min(w, h) / 2;
      body.push(`<circle cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" r="${n(r)}" fill="${sel ? p.accent : p.text}" stroke="none"/>`);
      if (nd.label) {
        body.push(
          `<text x="${n(x + w / 2)}" y="${n(y - 8)}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${p.textDim}">${esc(nd.label)}</text>`,
        );
      }
      break;
    }
    case 'final': {
      const r = Math.min(w, h) / 2;
      body.push(`<circle cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" r="${n(r)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`);
      body.push(`<circle cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" r="${n(r - 4)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`);
      break;
    }
    case 'junction': {
      body.push(
        `<path d="M${n(x + w / 2)},${n(y)} L${n(x + w)},${n(y + h / 2)} L${n(x + w / 2)},${n(y + h)} L${n(x)},${n(y + h / 2)} Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
      );
      if (nd.label) {
        body.push(
          `<text x="${n(x + w / 2)}" y="${n(y - 7)}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="${p.textDim}">${esc(nd.label)}</text>`,
        );
      }
      break;
    }
    case 'reg': {
      body.push(rect());
      const cy = y + h / 2;
      body.push(
        `<path d="M${n(x)},${n(cy - 7)} L${n(x + 9)},${n(cy)} L${n(x)},${n(cy + 7)}" fill="none" stroke="${stroke}" stroke-width="1.3"/>`,
      );
      body.push(textBlock(nd, p));
      break;
    }
    case 'state':
    default: {
      body.push(
        nd.type === 'state'
          ? `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(Math.min(18, h / 3))}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`
          : rect(),
      );
      body.push(textBlock(nd, p, { w: nd.type === 'state' ? w - 20 : w }));
      break;
    }
  }

  if (nd.type !== 'group' && nd.type !== 'frame') body.push(portMarks(nd, p, opt));

  let overlay = '';
  if (sel) {
    overlay += `<rect x="${n(x - 5)}" y="${n(y - 5)}" width="${n(w + 10)}" height="${n(h + 10)}" rx="7" fill="none" stroke="${p.accent}" stroke-width="1" stroke-dasharray="4 3" opacity="0.85"/>`;
    if (opt.handles) overlay += handles(nd, p);
  }

  return `<g${hit}>${hitRect}${body.join('')}${overlay}</g>`;
}

function portMarks(nd: DiagramNode, p: Palette, opt: RenderOptions): string {
  if (!nd.ports.length) return '';
  const out: string[] = [];
  for (const port of nd.ports) {
    const a = portAnchor(nd, port.side, port.name);
    const tag = opt.interactive ? ` data-anchor="${esc(nd.id)}:${port.side}:${esc(port.name)}" class="fd-anchor"` : '';
    out.push(`<circle cx="${n(a.x)}" cy="${n(a.y)}" r="3" fill="${p.nodeStroke}" stroke="${p.nodeFill}" stroke-width="1"${tag}/>`);
    const isLeft = port.side === 'l';
    const tx = isLeft ? a.x + 7 : port.side === 'r' ? a.x - 7 : a.x;
    const anchor = isLeft ? 'start' : port.side === 'r' ? 'end' : 'middle';
    const ty = port.side === 't' ? a.y + 12 : port.side === 'b' ? a.y - 6 : a.y + 3.5;
    out.push(
      `<text x="${n(tx)}" y="${n(ty)}" text-anchor="${anchor}" font-family="${MONO}" font-size="9.5" fill="${p.textDim}">${esc(port.name)}</text>`,
    );
  }
  return out.join('');
}

function handles(nd: DiagramNode, p: Palette): string {
  const s = 3.2;
  const pts: [string, number, number][] = [
    ['nw', nd.x, nd.y],
    ['n', nd.x + nd.w / 2, nd.y],
    ['ne', nd.x + nd.w, nd.y],
    ['e', nd.x + nd.w, nd.y + nd.h / 2],
    ['se', nd.x + nd.w, nd.y + nd.h],
    ['s', nd.x + nd.w / 2, nd.y + nd.h],
    ['sw', nd.x, nd.y + nd.h],
    ['w', nd.x, nd.y + nd.h / 2],
  ];
  return pts
    .map(
      ([h, x, y]) =>
        `<rect data-handle="${h}" x="${n(x - s)}" y="${n(y - s)}" width="${n(s * 2)}" height="${n(s * 2)}" fill="${p.bg}" stroke="${p.accent}" stroke-width="1.4" class="fd-handle"/>`,
    )
    .join('');
}

function anchorDots(nd: DiagramNode, p: Palette, opt: RenderOptions): string {
  if (!opt.interactive) return '';
  const out: string[] = [];
  for (const side of ['l', 'r', 't', 'b'] as Side[]) {
    if (nd.ports.some((x) => x.side === side)) continue;
    const a = portAnchor(nd, side);
    out.push(
      `<circle data-anchor="${esc(nd.id)}:${side}" cx="${n(a.x)}" cy="${n(a.y)}" r="5" fill="${p.bg}" stroke="${p.accent}" stroke-width="1.6" class="fd-anchor"/>`,
    );
  }
  return out.join('');
}

function groupSvg(nd: DiagramNode, p: Palette, opt: RenderOptions): string {
  const sel = !!opt.selection?.includes(nd.id);
  const hit = opt.interactive ? ` data-node="${esc(nd.id)}" class="fd-node"` : '';
  return `<g${hit}><rect x="${n(nd.x)}" y="${n(nd.y + 16)}" width="${n(nd.w)}" height="${n(nd.h - 16)}" rx="8" fill="${p.band}" fill-opacity="0.55" stroke="${sel ? p.accent : p.groupStroke}" stroke-width="${sel ? 1.8 : 1.1}" stroke-dasharray="6 4"/><text x="${n(nd.x + 10)}" y="${n(nd.y + 11)}" font-family="${FONT}" font-size="11.5" fill="${p.textDim}">${esc(nd.label)}</text></g>`;
}

// ---------------------------------------------------------------- frames

/**
 * 层次框：实线/虚线矩形 + 标题 + 边框端口。
 * 端口画成伸出框外的短线加箭头，名字写在框外——这是硬件框图里
 * "信号穿过模块边界"的惯用画法。
 */
function frameSvg(d: Diagram, nd: DiagramNode, p: Palette, opt: RenderOptions): string {
  const sel = !!opt.selection?.includes(nd.id);
  const stroke = sel ? p.accent : nd.dash ? p.groupStroke : p.nodeStroke;
  const sw = sel ? 1.8 : nd.dash ? 1.1 : 1.3;
  const dash = nd.dash ? ' stroke-dasharray="6 4"' : '';
  const hit = opt.interactive ? ` data-node="${esc(nd.id)}" class="fd-node"` : '';
  const out: string[] = [];
  out.push(
    `<rect x="${n(nd.x)}" y="${n(nd.y)}" width="${n(nd.w)}" height="${n(nd.h)}" fill="none" stroke="${stroke}" stroke-width="${sw}"${dash}/>`,
  );
  if (opt.interactive) {
    // 边框本身太细不好点中，加一条透明宽带做命中区
    out.push(
      `<rect x="${n(nd.x)}" y="${n(nd.y)}" width="${n(nd.w)}" height="${n(nd.h)}" fill="none" stroke="transparent" stroke-width="10"${hit}/>`,
    );
  }

  if (nd.label) {
    const fs = 11.5;
    const tw = measure(nd.label, fs);
    if (nd.titlePos === 'br') {
      out.push(
        `<text x="${n(nd.x + nd.w - 8)}" y="${n(nd.y + nd.h - 8)}" text-anchor="end" font-family="${FONT}" font-size="${fs}" fill="${p.textDim}">${esc(nd.label)}</text>`,
      );
    } else {
      // 标题骑在顶边中线上，用背景色块把边框断开，和框图惯例一致
      const cx = nd.x + nd.w / 2;
      out.push(
        `<rect x="${n(cx - tw / 2 - 6)}" y="${n(nd.y - 8)}" width="${n(tw + 12)}" height="16" fill="${p.bg}"/>`,
      );
      out.push(
        `<text x="${n(cx)}" y="${n(nd.y + 4)}" text-anchor="middle" font-family="${FONT}" font-size="${fs}" fill="${sel ? p.accent : p.text}">${esc(nd.label)}</text>`,
      );
    }
  }

  out.push(framePorts(nd, p, opt));
  void d;
  return `<g>${out.join('')}</g>`;
}

function framePorts(nd: DiagramNode, p: Palette, opt: RenderOptions): string {
  if (!nd.ports.length) return '';
  const out: string[] = [];
  const len = 22;
  for (const port of nd.ports) {
    if (port.side !== 'l' && port.side !== 'r') continue;
    const a = portAnchor(nd, port.side, port.name);
    const sign = port.side === 'l' ? -1 : 1;
    const outer = { x: a.x + sign * len, y: a.y };
    const dir = port.dir ?? (port.side === 'l' ? 'in' : 'out');
    const tag = opt.interactive ? ` data-anchor="${esc(nd.id)}:${port.side}:${esc(port.name)}" class="fd-anchor"` : '';
    const line =
      dir === 'in'
        ? `M${n(outer.x)},${n(outer.y)} L${n(a.x)},${n(a.y)}`
        : `M${n(a.x)},${n(a.y)} L${n(outer.x)},${n(outer.y)}`;
    const marks =
      dir === 'in'
        ? ' marker-end="url(#arw-wire)"'
        : dir === 'out'
          ? ' marker-end="url(#arw-wire)"'
          : ' marker-start="url(#arw-wire)" marker-end="url(#arw-wire)"';
    out.push(`<path d="${line}" fill="none" stroke="${p.wire}" stroke-width="1.1"${marks}/>`);
    const tx = outer.x + sign * 5;
    out.push(
      `<text x="${n(tx)}" y="${n(outer.y + 3.4)}" text-anchor="${sign < 0 ? 'end' : 'start'}" font-family="${MONO}" font-size="9.5" fill="${p.textDim}"${tag}>${esc(port.name)}</text>`,
    );
    void tag;
  }
  return out.join('');
}

// ---------------------------------------------------------------- edges

export function portAnchor(nd: DiagramNode, side: Side, portName?: string): Anchor {
  const ports = nd.ports.filter((x) => x.side === side);
  let t = 0.5;
  if (ports.length) {
    const idx = portName ? ports.findIndex((x) => x.name === portName) : -1;
    t = idx >= 0 ? (idx + 1) / (ports.length + 1) : 0.5;
  }
  switch (side) {
    case 'l':
      return { x: nd.x, y: nd.y + nd.h * t, side };
    case 'r':
      return { x: nd.x + nd.w, y: nd.y + nd.h * t, side };
    case 't':
      return { x: nd.x + nd.w * t, y: nd.y, side };
    default:
      return { x: nd.x + nd.w * t, y: nd.y + nd.h, side };
  }
}

function centerOf(nd: DiagramNode): Pt {
  return { x: nd.x + nd.w / 2, y: nd.y + nd.h / 2 };
}

function autoSide(from: DiagramNode, to: DiagramNode): Side {
  const a = centerOf(from);
  const b = centerOf(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const nx = Math.abs(dx) / Math.max(1, (from.w + to.w) / 2);
  const ny = Math.abs(dy) / Math.max(1, (from.h + to.h) / 2);
  if (nx >= ny) return dx >= 0 ? 'r' : 'l';
  return dy >= 0 ? 'b' : 't';
}

export function resolveEdge(d: Diagram, e: DiagramEdge): { a: Anchor; b: Anchor } | null {
  const from = d.nodes.find((x) => x.id === e.from.node);
  const to = d.nodes.find((x) => x.id === e.to.node);
  if (!from || !to) return null;
  const aSide = e.from.side ?? autoSide(from, to);
  const bSide = e.to.side ?? autoSide(to, from);
  return { a: portAnchor(from, aSide, e.from.port), b: portAnchor(to, bSide, e.to.port) };
}

/** 连线（可见折线/曲线）的中点——插入新节点时就摆在这里，箭头自然从中间穿过 */
export function edgeMidpoint(d: Diagram, e: DiagramEdge): Pt | null {
  if (e.from.node === e.to.node) {
    const nd = d.nodes.find((x) => x.id === e.from.node);
    return nd ? selfLoopPath(nd).mid : null;
  }
  const pair = resolveEdge(d, e);
  if (!pair) return null;
  const route = effectiveRoute(d, e);
  if (route === 'straight') return { x: (pair.a.x + pair.b.x) / 2, y: (pair.a.y + pair.b.y) / 2 };
  if (route === 'curve') return { x: (pair.a.x + pair.b.x) / 2, y: (pair.a.y + pair.b.y) / 2 };
  const pts = routePoints(d, pair.a, pair.b, 0, new Set([e.from.node, e.to.node]));
  return midOfPath(pts).p;
}

function outDir(side: Side): Pt {
  switch (side) {
    case 'l':
      return { x: -1, y: 0 };
    case 'r':
      return { x: 1, y: 0 };
    case 't':
      return { x: 0, y: -1 };
    default:
      return { x: 0, y: 1 };
  }
}

function segHitsRect(p: Pt, q: Pt, r: { x: number; y: number; w: number; h: number }): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const checks: [number, number][] = [
    [-dx, p.x - r.x],
    [dx, r.x + r.w - p.x],
    [-dy, p.y - r.y],
    [dy, r.y + r.h - p.y],
  ];
  for (const [pp, qq] of checks) {
    if (pp === 0) {
      if (qq < 0) return false;
    } else {
      const t = qq / pp;
      if (pp < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

function pathScore(pts: Pt[], d: Diagram, skip: Set<string>): number {
  let hits = 0;
  let length = 0;
  for (let i = 1; i < pts.length; i++) {
    length += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    for (const nd of d.nodes) {
      if (skip.has(nd.id) || nd.type === 'group') continue;
      const box = { x: nd.x - 3, y: nd.y - 3, w: nd.w + 6, h: nd.h + 6 };
      if (segHitsRect(pts[i - 1], pts[i], box)) hits += 1;
    }
  }
  return hits * 1000 + length;
}

/** 生成若干条候选正交路径，挑一条不穿过其他节点、且最短的 */
function routePoints(d: Diagram, a: Anchor, b: Anchor, lane: number, skip: Set<string>): Pt[] {
  const stub = 20;
  const da = outDir(a.side);
  const db = outDir(b.side);
  const p1 = { x: a.x + da.x * stub, y: a.y + da.y * stub };
  const p2 = { x: b.x + db.x * stub, y: b.y + db.y * stub };
  const ah = a.side === 'l' || a.side === 'r';
  const bh = b.side === 'l' || b.side === 'r';
  const cands: Pt[][] = [];

  if (ah && bh) {
    const mx = (p1.x + p2.x) / 2 + lane * 18;
    cands.push([{ x: a.x, y: a.y }, p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2, { x: b.x, y: b.y }]);
    const my = (p1.y + p2.y) / 2 + lane * 18;
    cands.push([{ x: a.x, y: a.y }, p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2, { x: b.x, y: b.y }]);
  } else if (!ah && !bh) {
    const my = (p1.y + p2.y) / 2 + lane * 18;
    cands.push([{ x: a.x, y: a.y }, p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2, { x: b.x, y: b.y }]);
    const mx = (p1.x + p2.x) / 2 + lane * 18;
    cands.push([{ x: a.x, y: a.y }, p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2, { x: b.x, y: b.y }]);
  } else if (ah) {
    cands.push([{ x: a.x, y: a.y }, p1, { x: p2.x, y: p1.y }, p2, { x: b.x, y: b.y }]);
    const my = (p1.y + p2.y) / 2;
    cands.push([{ x: a.x, y: a.y }, p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2, { x: b.x, y: b.y }]);
  } else {
    cands.push([{ x: a.x, y: a.y }, p1, { x: p1.x, y: p2.y }, p2, { x: b.x, y: b.y }]);
    const mx = (p1.x + p2.x) / 2;
    cands.push([{ x: a.x, y: a.y }, p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2, { x: b.x, y: b.y }]);
  }

  // 绕行候选：从两端节点外侧兜一圈
  const minY = Math.min(a.y, b.y) - 46;
  const maxY = Math.max(a.y, b.y) + 46;
  const minX = Math.min(a.x, b.x) - 46;
  const maxX = Math.max(a.x, b.x) + 46;
  cands.push([{ x: a.x, y: a.y }, p1, { x: p1.x, y: minY }, { x: p2.x, y: minY }, p2, { x: b.x, y: b.y }]);
  cands.push([{ x: a.x, y: a.y }, p1, { x: p1.x, y: maxY }, { x: p2.x, y: maxY }, p2, { x: b.x, y: b.y }]);
  cands.push([{ x: a.x, y: a.y }, p1, { x: minX, y: p1.y }, { x: minX, y: p2.y }, p2, { x: b.x, y: b.y }]);
  cands.push([{ x: a.x, y: a.y }, p1, { x: maxX, y: p1.y }, { x: maxX, y: p2.y }, p2, { x: b.x, y: b.y }]);

  let best = cands[0];
  let bestScore = Infinity;
  for (const c of cands) {
    const pts = dedupe(c);
    const sc = pathScore(pts, d, skip);
    if (sc < bestScore) {
      bestScore = sc;
      best = pts;
    }
  }
  return best;
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.5 || Math.abs(last.y - p.y) > 0.5) out.push(p);
  }
  return out;
}

function roundPath(pts: Pt[], r = 9): string {
  if (pts.length < 2) return '';
  let d = `M${n(pts[0].x)},${n(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const v1 = { x: p1.x - p0.x, y: p1.y - p0.y };
    const v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    if (l1 < 1 || l2 < 1) {
      d += ` L${n(p1.x)},${n(p1.y)}`;
      continue;
    }
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = p1.x - (v1.x / l1) * rr;
    const ay = p1.y - (v1.y / l1) * rr;
    const bx = p1.x + (v2.x / l2) * rr;
    const by = p1.y + (v2.y / l2) * rr;
    d += ` L${n(ax)},${n(ay)} Q${n(p1.x)},${n(p1.y)} ${n(bx)},${n(by)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${n(last.x)},${n(last.y)}`;
  return d;
}

function selfLoopPath(nd: DiagramNode): { d: string; mid: Pt } {
  const cx = nd.x + nd.w;
  const cy = nd.y + nd.h / 2;
  const off = 42;
  const d = `M${n(cx)},${n(cy - 10)} C${n(cx + off)},${n(cy - 46)} ${n(cx + off)},${n(nd.y - 52)} ${n(nd.x + nd.w / 2)},${n(nd.y - 46)} C${n(nd.x + nd.w / 2 - off)},${n(nd.y - 42)} ${n(nd.x + 12)},${n(nd.y - 6)} ${n(nd.x + 12)},${n(cy - 6)}`;
  return { d, mid: { x: nd.x + nd.w / 2 + 6, y: nd.y - 44 } };
}

function midOfPath(pts: Pt[]): { p: Pt; dir: Pt } {
  if (pts.length === 1) return { p: pts[0], dir: { x: 1, y: 0 } };
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const seg = Math.hypot(dx, dy);
    if (acc + seg >= total / 2) {
      const t = seg === 0 ? 0 : (total / 2 - acc) / seg;
      const len = seg || 1;
      return { p: { x: pts[i - 1].x + dx * t, y: pts[i - 1].y + dy * t }, dir: { x: dx / len, y: dy / len } };
    }
    acc += seg;
  }
  const last = pts[pts.length - 1];
  return { p: last, dir: { x: 1, y: 0 } };
}

/** 避开节点与线身的标签位置：按重叠面积打分挑选最佳偏移 */
function placeLabel(
  d: Diagram,
  mid: { p: Pt; dir: Pt },
  w: number,
  h: number,
  taken: { x: number; y: number; w: number; h: number }[] = [],
  minOff = 16,
): Pt {
  const nx = -mid.dir.y;
  const ny = mid.dir.x;
  const overlap = (cx: number, cy: number): number => {
    let area = 0;
    const x0 = cx - w / 2 - 3;
    const y0 = cy - h / 2 - 3;
    for (const nd of d.nodes) {
      const ox = Math.min(x0 + w + 6, nd.x + nd.w) - Math.max(x0, nd.x);
      const oy = Math.min(y0 + h + 6, nd.y + nd.h) - Math.max(y0, nd.y);
      if (ox > 0 && oy > 0) area += ox * oy;
    }
    for (const b of taken) {
      const ox = Math.min(x0 + w + 6, b.x + b.w) - Math.max(x0, b.x);
      const oy = Math.min(y0 + h + 6, b.y + b.h) - Math.max(y0, b.y);
      if (ox > 0 && oy > 0) area += ox * oy * 1.6;
    }
    return area;
  };
  let best: Pt = { x: mid.p.x, y: mid.p.y };
  let bestScore = Infinity;
  const offs: number[] = [];
  for (let k = 0; k < 5; k++) offs.push(minOff + k * 9, -(minOff + k * 9));
  for (const off of offs) {
    for (const along of [0, -20, 20, -38, 38]) {
      const cx = mid.p.x + nx * off + mid.dir.x * along;
      const cy = mid.p.y + ny * off + mid.dir.y * along;
      const score = overlap(cx, cy) * 3 + Math.abs(off) * 1.1 + Math.abs(along) * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = { x: cx, y: cy };
      }
    }
  }
  return best;
}

/** 环形态下正交折线会绕成一团，改用曲线 */
function effectiveRoute(d: Diagram, e: DiagramEdge): EdgeRoute {
  const circular = d.kind === 'fsm' && (d.options.layout === 'auto' || d.options.layout === 'circular');
  if (circular && e.route === 'orth') return 'curve';
  return e.route;
}

function edgeSvg(d: Diagram, e: DiagramEdge, p: Palette, opt: RenderOptions): string {
  const sel = !!opt.selEdges?.includes(e.id);
  const route = effectiveRoute(d, e);
  const hot = opt.dropEdge === e.id;
  const color = sel || hot ? p.accent : edgeColor(p, e.style);
  const width = hot ? 3 : e.style === 'bus' ? 2.4 : e.style === 'clock' ? 1.6 : 1.5;
  const marker = `arw-${sel || hot ? 'accent' : e.style}`;
  const dash = e.style === 'ctrl' ? ' stroke-dasharray="6 4"' : '';

  let dPath = '';
  let mid: { p: Pt; dir: Pt } | null = null;
  let fixed = false;
  let laneOffset = 0;

  if (e.from.node === e.to.node) {
    const node = d.nodes.find((x) => x.id === e.from.node)!;
    const loop = selfLoopPath(node);
    dPath = loop.d;
    mid = { p: loop.mid, dir: { x: 1, y: 0 } };
    fixed = true;
  } else {
    const anchors = resolveEdge(d, e);
    if (!anchors) return '';
    const { a, b } = anchors;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // 同一对节点之间的多条边要分道，否则正反两个方向会完全重合
    const siblings = d.edges.filter(
      (o) => (o.from.node === e.from.node && o.to.node === e.to.node) || (o.from.node === e.to.node && o.to.node === e.from.node),
    );
    const laneCount = siblings.length;
    let laneIndex = 0;
    if (laneCount > 1) {
      // 按"规范方向 → id"排序后取序号；法线方向也统一到规范方向，
      // 否则正反两条边的偏移会互相抵消，看起来还是一条线
      const dirKey = (o: DiagramEdge) => (o.from.node < o.to.node ? '0' : '1');
      const ordered = [...siblings].sort((x, y) => (dirKey(x) + x.id).localeCompare(dirKey(y) + y.id));
      laneIndex = Math.max(0, ordered.findIndex((o) => o.id === e.id));
    }
    laneOffset = laneCount > 1 ? (laneIndex - (laneCount - 1) / 2) * 20 : 0;
    const flip = e.from.node > e.to.node ? -1 : 1;

    if (route === 'straight') {
      dPath = `M${n(a.x)},${n(a.y)} L${n(b.x)},${n(b.y)}`;
      mid = { p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dir: { x: dx / len, y: dy / len } };
    } else if (route === 'curve') {
      const da = outDir(a.side);
      const db = outDir(b.side);
      const k = Math.max(46, Math.abs(b.x - a.x) / 2 + Math.abs(b.y - a.y) / 4);
      const c1 = { x: a.x + da.x * k, y: a.y + da.y * k };
      const c2 = { x: b.x + db.x * k, y: b.y + db.y * k };
      if (laneOffset) {
        const nx = (-dy / len) * flip;
        const ny = (dx / len) * flip;
        c1.x += nx * laneOffset;
        c1.y += ny * laneOffset;
        c2.x += nx * laneOffset;
        c2.y += ny * laneOffset;
      }
      dPath = `M${n(a.x)},${n(a.y)} C${n(c1.x)},${n(c1.y)} ${n(c2.x)},${n(c2.y)} ${n(b.x)},${n(b.y)}`;
      mid = { p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dir: { x: dx / len, y: dy / len } };
      if (laneOffset) {
        mid.p.x += (-dy / len) * flip * laneOffset * 0.6;
        mid.p.y += (dx / len) * flip * laneOffset * 0.6;
      }
    } else {
      const lane = laneCount > 1 ? laneIndex : 0;
      const pts = routePoints(d, a, b, lane, new Set([e.from.node, e.to.node]));
      dPath = roundPath(pts);
      mid = midOfPath(pts);
    }
  }

  const out: string[] = [];
  const dataAttr = opt.interactive ? ` data-edge="${esc(e.id)}"` : '';
  if (opt.interactive) out.push(`<path d="${dPath}" fill="none" stroke="transparent" stroke-width="14"${dataAttr} class="fd-edge"/>`);
  out.push(
    `<path d="${dPath}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="butt"${dash} marker-end="${e.arrow === 'none' ? '' : `url(#${marker})`}"${e.arrow === 'both' ? ` marker-start="url(#${marker})"` : ''}${dataAttr} class="fd-edge${opt.interactive ? ' fd-edge-line' : ''}"/>`,
  );

  const labelText = [e.label, e.action].filter(Boolean).join(' / ');
  if (labelText && mid) {
    const tw = measure(labelText, 10.5) + 10;
    const th = 15;
    const at = fixed ? mid.p : placeLabel(d, mid, tw, th, opt.labelBoxes, Math.abs(laneOffset) + 16);
    const lx = at.x - tw / 2;
    const ly = at.y - th / 2;
    opt.labelBoxes?.push({ x: lx, y: ly, w: tw, h: th });
    out.push(
      `<rect x="${n(lx)}" y="${n(ly)}" width="${n(tw)}" height="${n(th)}" rx="3" fill="${p.bg}" fill-opacity="0.94" stroke="${p.gridMajor}" stroke-width="0.8"/>`,
    );
    out.push(
      `<text x="${n(at.x)}" y="${n(ly + 11)}" text-anchor="middle" font-family="${FONT}" font-size="10.5" fill="${sel ? p.accent : p.textDim}">${esc(labelText)}</text>`,
    );
  }
  const cls = `fd-edge-g${hot ? ' fd-edge-drop' : ''}`;
  const dataAttrG = opt.interactive ? ` data-edge="${esc(e.id)}"` : '';
  return `<g class="${cls}"${dataAttrG}>${out.join('')}</g>`;
}

// ---------------------------------------------------------------- timing

export const LABEL_W = 156;
export const ROW_H = 34;
export const AXIS_H = 26;
export const PANEL_TITLE_H = 26;
export const PANEL_GAP = 20;

/** 每拍像素宽 */
export function stepW(_d?: Diagram): number {
  return 34;
}

export function panelWidth(p: TimingPanel, sw = stepW()): number {
  return LABEL_W + p.steps * sw + 16;
}

export function timingWidth(d: Diagram): number {
  const widest = Math.max(1, ...d.panels.map((p) => p.steps));
  return LABEL_W + widest * stepW(d) + 16;
}

export function panelHeight(p: TimingPanel): number {
  return (p.title ? PANEL_TITLE_H : 0) + p.rows.length * ROW_H + AXIS_H + 6;
}

export function timingHeight(d: Diagram): number {
  if (!d.panels.length) return PANEL_TITLE_H;
  return d.panels.reduce((s, p) => s + panelHeight(p), 0) + Math.max(0, d.panels.length - 1) * PANEL_GAP;
}

/** 时间基准：每拍多少 ns */
export function tickOf(d: Diagram): number {
  return d.tick && d.tick > 0 ? d.tick : 10;
}

function timingBody(d: Diagram, p: Palette, opt: RenderOptions): string {
  const out: string[] = [];
  const sw = stepW(d);
  const width = timingWidth(d);
  out.push(`<rect x="0" y="0" width="${n(width)}" height="${n(timingHeight(d))}" fill="none"/>`);
  let y = 0;
  d.panels.forEach((panel, pi) => {
    out.push(`<g transform="translate(0,${n(y)})">${panelBody(d, panel, pi, p, opt, sw)}</g>`);
    y += panelHeight(panel) + PANEL_GAP;
  });
  return out.join('');
}

function panelBody(
  d: Diagram,
  panel: TimingPanel,
  pi: number,
  p: Palette,
  opt: RenderOptions,
  sw: number,
): string {
  const out: string[] = [];
  const tick = tickOf(d);
  const x0 = LABEL_W;
  const total = x0 + panel.steps * sw;
  const titleH = panel.title ? PANEL_TITLE_H : 0;

  if (panel.title) {
    out.push(
      `<text x="2" y="17" font-family="${FONT}" font-size="12" font-weight="600" fill="${p.text}">${esc(panel.title)}</text>`,
    );
    const label = `${panel.steps} 拍 · ${Math.round(panel.steps * tick)} ns · ${tick} ns/拍`;
    out.push(
      `<text x="${n(total)}" y="17" text-anchor="end" font-family="${MONO}" font-size="10" fill="${p.textDim}">${esc(label)}</text>`,
    );
  } else if (pi > 0) {
    // 无标题的第二组：画一条分隔线，避免看成同一组
    out.push(`<line x1="0" y1="2" x2="${n(total)}" y2="2" stroke="${p.gridMajor}" stroke-width="1" stroke-dasharray="5 4"/>`);
  }

  const top0 = titleH;
  const height = panel.rows.length * ROW_H;

  // 竖向网格
  for (let i = 0; i <= panel.steps; i++) {
    const x = x0 + i * sw;
    const major = i % 4 === 0;
    out.push(
      `<line x1="${n(x)}" y1="${n(top0)}" x2="${n(x)}" y2="${n(top0 + height)}" stroke="${major ? p.gridMajor : p.grid}" stroke-width="1"/>`,
    );
  }

  panel.rows.forEach((row, i) => {
    const y = top0 + i * ROW_H;
    if (opt.selRow && opt.selRow.panel === pi && opt.selRow.row === i) {
      out.push(`<rect x="0" y="${n(y)}" width="${n(total)}" height="${n(ROW_H)}" fill="${p.accent}" fill-opacity="0.08"/>`);
    }
    out.push(`<line x1="0" y1="${n(y + ROW_H)}" x2="${n(total)}" y2="${n(y + ROW_H)}" stroke="${p.grid}" stroke-width="1"/>`);
    if (row.type === 'group') {
      out.push(`<rect x="0" y="${n(y)}" width="${n(total)}" height="${n(ROW_H)}" fill="${p.band}"/>`);
      out.push(
        `<text x="10" y="${n(y + ROW_H / 2 + 4)}" font-family="${FONT}" font-size="11.5" font-weight="500" fill="${p.text}">${esc(row.name)}</text>`,
      );
      return;
    }
    out.push(
      `<text x="10" y="${n(y + ROW_H / 2 + 4)}" font-family="${MONO}" font-size="11.5" fill="${p.text}">${esc(row.name)}</text>`,
    );
    if (row.type === 'clock' && row.freq) {
      out.push(
        `<text x="${n(LABEL_W - 12)}" y="${n(y + ROW_H / 2 + 4)}" text-anchor="end" font-family="${MONO}" font-size="9.5" fill="${p.textDim}">${esc(freqLabel(row.freq))}</text>`,
      );
    }
    const top = y + 7;
    const bot = y + ROW_H - 9;
    const mid = (top + bot) / 2;

    if (row.type === 'clock') {
      out.push(clockPath(row, x0, sw, panel.steps, top, bot, p));
    } else if (row.type === 'bus') {
      out.push(busBody(row, x0, sw, panel.steps, top, bot, p));
    } else {
      out.push(logicBody(row, x0, sw, panel.steps, top, bot, mid, p));
    }

    if (opt.interactive) {
      for (let c = 0; c < panel.steps; c++) {
        out.push(
          `<rect data-cell="${pi}:${i}:${c}" x="${n(x0 + c * sw)}" y="${n(y)}" width="${n(sw)}" height="${n(ROW_H)}" fill="transparent" class="fd-cell"/>`,
        );
      }
      out.push(`<rect data-rowname="${pi}:${i}" x="0" y="${n(y)}" width="${n(LABEL_W - 8)}" height="${n(ROW_H)}" fill="transparent" class="fd-rowname"/>`);
    }
  });

  // 时间轴
  const ay = top0 + height + 4;
  const axisEnd = x0 + panel.steps * sw;
  out.push(`<line x1="${n(x0)}" y1="${n(ay)}" x2="${n(axisEnd)}" y2="${n(ay)}" stroke="${p.axis}" stroke-width="1"/>`);
  const every = panel.steps > 32 ? 8 : 4;
  for (let i = 0; i <= panel.steps; i++) {
    if (i % every !== 0 && i !== panel.steps) continue;
    const x = x0 + i * sw;
    out.push(`<line x1="${n(x)}" y1="${n(ay)}" x2="${n(x)}" y2="${n(ay + 4)}" stroke="${p.axis}" stroke-width="1"/>`);
    const ns = i * tick;
    const label = tick >= 1 ? String(Math.round(ns)) : String(Number(ns.toFixed(1)));
    out.push(
      `<text x="${n(x)}" y="${n(ay + 16)}" text-anchor="middle" font-family="${MONO}" font-size="9.5" fill="${p.textDim}">${label}</text>`,
    );
  }
  out.push(
    `<text x="10" y="${n(ay + 16)}" font-family="${FONT}" font-size="10" fill="${p.textDim}">ns</text>`,
  );
  return out.join('');
}

export function freqLabel(mhz: number): string {
  const v = mhz >= 1000 ? mhz / 1000 : mhz;
  const unit = mhz >= 1000 ? 'GHz' : 'MHz';
  const s = Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 2 : 1).replace(/\.?0+$/, '');
  return `${s}${unit}`;
}

/**
 * 总线的规则（和单比特不同）：
 *  - 每格是一个"值标记"，空格 = 保持左边最近的值，`z` = 断开（高阻，虚线）
 *  - 段的左右边界永远落在格线上，斜边只是 6px 的视觉过渡，不代表半拍
 *  - 值一直保持到下一次显式改变；要中断就在那一格写 z
 */
export function effectiveValues(row: { values: string[]; type?: string }, steps: number): string[] {
  const out: string[] = [];
  const isBus = row.type === 'bus';
  let last = isBus ? '' : '0';
  for (let i = 0; i < steps; i++) {
    const v = row.values[i];
    if (v === '' || v === undefined) out.push(last);
    else {
      out.push(v);
      last = v;
    }
  }
  return out;
}

function clockPath(
  row: { period?: number; duty?: number; phase?: number },
  x0: number,
  sw: number,
  steps: number,
  top: number,
  bot: number,
  p: Palette,
): string {
  const period = Math.max(2, Math.round(row.period ?? 2));
  const duty = row.duty ?? 0.5;
  const phase = (((row.phase ?? 0) % period) + period) % period;
  const highCols = Math.min(period, Math.max(1, Math.round(period * duty)));
  let d = '';
  let prevHigh: boolean | null = null;
  for (let i = 0; i < steps; i++) {
    const within = (((i - phase) % period) + period) % period;
    const isHigh = within < highCols;
    const y = isHigh ? top : bot;
    const x = x0 + i * sw;
    if (prevHigh === null) d = `M${n(x)},${n(y)}`;
    else if (prevHigh !== isHigh) d += ` V${n(y)}`;
    d += ` H${n(x + sw)}`;
    prevHigh = isHigh;
  }
  return `<path d="${d}" fill="none" stroke="${p.clock}" stroke-width="1.7" stroke-linejoin="miter"/>`;
}

function logicBody(
  row: { values: string[] },
  x0: number,
  sw: number,
  steps: number,
  top: number,
  bot: number,
  mid: number,
  p: Palette,
): string {
  const vals = effectiveValues(row as any, steps);
  const out: string[] = [];
  const lvl = (v: string) => (v === '1' ? top : bot);
  let i = 0;
  while (i < steps) {
    const v = vals[i];
    if (v === 'z') {
      let j = i;
      while (j < steps && vals[j] === 'z') j++;
      out.push(
        `<line x1="${n(x0 + i * sw)}" y1="${n(mid)}" x2="${n(x0 + j * sw)}" y2="${n(mid)}" stroke="${p.wire}" stroke-width="1.4" stroke-dasharray="4 3"/>`,
      );
      i = j;
      continue;
    }
    if (v === 'x') {
      let j = i;
      while (j < steps && vals[j] === 'x') j++;
      const xa = x0 + i * sw;
      const xb = x0 + j * sw;
      out.push(
        `<rect x="${n(xa)}" y="${n(top)}" width="${n(xb - xa)}" height="${n(bot - top)}" fill="${p.band}" stroke="${p.wire}" stroke-width="1.2"/>`,
      );
      out.push(
        `<line x1="${n(xa)}" y1="${n(top)}" x2="${n(xb)}" y2="${n(bot)}" stroke="${p.wire}" stroke-width="1"/><line x1="${n(xa)}" y1="${n(bot)}" x2="${n(xb)}" y2="${n(top)}" stroke="${p.wire}" stroke-width="1"/>`,
      );
      i = j;
      continue;
    }
    // 0/1 连续段
    let cur = lvl(v);
    let d = `M${n(x0 + i * sw)},${n(cur)}`;
    let j = i;
    while (j < steps && (vals[j] === '0' || vals[j] === '1')) {
      const lv = lvl(vals[j]);
      if (lv !== cur) {
        d += ` V${n(lv)}`;
        cur = lv;
      }
      d += ` H${n(x0 + (j + 1) * sw)}`;
      j++;
    }
    out.push(`<path d="${d}" fill="none" stroke="${p.accent}" stroke-width="1.7" stroke-linejoin="miter"/>`);
    i = j;
  }
  return out.join('');
}

function busBody(
  row: { values: string[] },
  x0: number,
  sw: number,
  steps: number,
  top: number,
  bot: number,
  p: Palette,
): string {
  const vals = effectiveValues(row as any, steps);
  const out: string[] = [];
  if (!steps) return '';
  const rects: string[] = [];
  const labels: string[] = [];
  const mid = (top + bot) / 2;
  let start = 0;
  let cur = vals[0];

  const emit = (a: number, b: number, value: string) => {
    const xa = x0 + a * sw;
    const xb = x0 + b * sw;
    const w = xb - xa;
    if (!value) return;
    if (value === 'z') {
      out.push(
        `<line x1="${n(xa)}" y1="${n(mid)}" x2="${n(xb)}" y2="${n(mid)}" stroke="${p.bus}" stroke-width="1.4" stroke-dasharray="4 3"/>`,
      );
      return;
    }
    if (value === 'x') {
      out.push(`<rect x="${n(xa)}" y="${n(top)}" width="${n(w)}" height="${n(bot - top)}" fill="${p.band}" stroke="${p.bus}" stroke-width="1.2"/>`);
      out.push(
        `<line x1="${n(xa)}" y1="${n(top)}" x2="${n(xb)}" y2="${n(bot)}" stroke="${p.bus}" stroke-width="1"/><line x1="${n(xa)}" y1="${n(bot)}" x2="${n(xb)}" y2="${n(top)}" stroke="${p.bus}" stroke-width="1"/>`,
      );
      return;
    }
    // 段 = 一整格到一整格的矩形；边界永远落在格线上，
    // 值宽 1 格就是 1 拍，绝不因为"过渡斜边"看起来像半拍
    rects.push(
      `<rect x="${n(xa)}" y="${n(top)}" width="${n(w)}" height="${n(bot - top)}" fill="${p.nodeFillAlt}" stroke="${p.bus}" stroke-width="1.3"/>`,
    );
    if (measure(value, 10) + 8 < w) {
      labels.push(
        `<text x="${n((xa + xb) / 2)}" y="${n(mid + 3.4)}" text-anchor="middle" font-family="${MONO}" font-size="10" fill="${p.text}">${esc(value)}</text>`,
      );
    }
  };

  for (let i = 1; i <= steps; i++) {
    if (i === steps || vals[i] !== cur) {
      emit(start, i, cur);
      start = i;
      cur = vals[i];
    }
  }

  out.push(...rects);

  // 相邻两段值不同：在格线上画一个小交叉，表示"这一拍换的值"
  for (let i = 1; i < steps; i++) {
    const a = vals[i - 1];
    const b = vals[i];
    if (!a || !b || a === b || a === 'z' || b === 'z' || a === 'x' || b === 'x') continue;
    const x = x0 + i * sw;
    out.push(
      `<path d="M${n(x - 3)},${n(top)} L${n(x + 3)},${n(bot)} M${n(x - 3)},${n(bot)} L${n(x + 3)},${n(top)}" stroke="${p.bus}" stroke-width="1" fill="none"/>`,
    );
  }
  out.push(...labels);
  return out.join('');
}

export function svgDocument(
  body: string,
  width: number,
  height: number,
  p: Palette,
  title?: string,
  scale = 1,
): string {
  const w = Math.ceil(width * scale);
  const h = Math.ceil(height * scale);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}">` +
    (title ? `<title>${esc(title)}</title>` : '') +
    `<rect width="100%" height="100%" fill="${p.bg}"/>` +
    body +
    `</svg>`
  );
}
