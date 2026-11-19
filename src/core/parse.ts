import * as yaml from 'js-yaml';
import {
  Diagram,
  DiagramEdge,
  DiagramNode,
  EdgeRoute,
  EdgeStyle,
  Kind,
  Port,
  SceneFile,
  Side,
  TimingPanel,
  TimingRow,
  LOW_LEVEL_TYPES,
  emptyDiagram,
  isKnownType,
  isLowLevelType,
  normalizeDir,
  resolveKind,
  resolveType,
  numText,
  shapeOf,
  syncClockFreqs,
  timingStats,
} from './model';

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  line?: number;
}

export interface ParseResult {
  diagram: Diagram;
  diagnostics: Diagnostic[];
}

export interface ParseFileResult {
  file: SceneFile;
  diagnostics: Diagnostic[];
}

const SIDES: Record<string, Side> = {
  l: 'l',
  left: 'l',
  左: 'l',
  r: 'r',
  right: 'r',
  右: 'r',
  t: 't',
  top: 't',
  上: 't',
  b: 'b',
  bottom: 'b',
  down: 'b',
  下: 'b',
};

const SIDE_CN: Record<Side, string> = { l: '左边', r: '右边', t: '上边', b: '下边' };

const STYLE_WORDS: Record<string, EdgeStyle> = {
  bus: 'bus',
  总线: 'bus',
  clock: 'clock',
  时钟: 'clock',
  clk: 'clock',
  ctrl: 'ctrl',
  控制: 'ctrl',
  control: 'ctrl',
  wire: 'wire',
  信号: 'wire',
  signal: 'wire',
};

const ROUTE_WORDS: Record<string, EdgeRoute> = {
  orth: 'orth',
  orthogonal: 'orth',
  折线: 'orth',
  straight: 'straight',
  直线: 'straight',
  line: 'straight',
  curve: 'curve',
  曲线: 'curve',
  curved: 'curve',
};

// ---------------------------------------------------------------- 字段白名单
// 以前键名写错（signals 写成 signal、nodes 写成 note）会静默通过：
// validate 返回 ok，图是空的，AI 拿不到任何反馈。这里对未知字段给 warning，
// 并附最近键名提示；`validate --strict` 会把它升级成 error。

const SCENE_KEYS = new Set([
  'version', 'kind', 'diagram_type', 'diagramType', 'title', 'id', 'direction', 'layout', 'tick', 'tickNs',
  'options', 'nodes', 'states', 'modules', 'edges', 'transitions', 'links', 'panels', 'groups', 'views',
  'signals', 'steps', 'meta', 'note', 'description',
]);

const NODE_KEYS = new Set([
  'id', 'name', 'label', 'sub', 'note', 'type', 'shape', 'ports', 'io', 'pos', 'x', 'y', 'size', 'children',
  'style', 'frame', 'dash', 'titlePos', 'titlepos', 'collapsed', 'data',
]);

const EDGE_KEYS = new Set([
  'from', 'to', 'source', 'target', 'from_port', 'to_port', 'label', 'text', 'action', 'style', 'visual',
  'route', 'arrow', 'waypoints', 'id',
]);

const ROW_KEYS = new Set([
  'name', 'id', 'type', 'values', 'value', 'wave', 'color', 'colour', 'width', 'bits', 'order', 'freq', 'mhz',
  'frequency', 'period', 'duty', 'phase', 'children', 'signals',
]);

const PANEL_KEYS = new Set(['title', 'name', 'steps', 'signals', 'rows', 'waveforms']);

/** 文件级：单图字段 + 多视图头，避免把 scenes 误报成未知键 */
const FILE_KEYS = new Set([...SCENE_KEYS, 'scenes', 'active']);

/** 编辑距离（只用于"是否想写 X"的提示，短字符串足够） */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function nearestKey(key: string, allowed: Set<string>): string | undefined {
  const low = key.toLowerCase();
  let best: string | undefined;
  let bestD = Infinity;
  for (const cand of allowed) {
    const d = editDistance(low, cand.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return best && bestD <= Math.max(2, Math.floor(key.length / 3)) ? best : undefined;
}

function warnUnknownKeys(
  o: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
  diags: Diagnostic[],
  line?: number,
): void {
  for (const k of Object.keys(o)) {
    if (allowed.has(k)) continue;
    const near = nearestKey(k, allowed);
    diags.push({
      severity: 'warning',
      message: `${where}的字段 "${k}" 无法识别${near ? `，是否想写 "${near}"？` : ''}`,
      line,
    });
  }
}

/** 端口引用可以带位宽后缀，如 `awaddr[19:0]` */
function portByRef(nd: DiagramNode, ref: string): Port | undefined {
  const norm = (s: string) => s.replace(/\s+/g, '');
  const want = norm(ref);
  return nd.ports.find((p) => norm(p.name) === want || (!!p.width && norm(`${p.name}[${p.width}]`) === want));
}


/**
 * 行号索引。旧实现是 `lines.findIndex(l => l.includes(needle))`：
 * 同名节点、重复 id、多条连线都会命中第一处，"带行号让 AI 自修正"反而变成误导。
 *
 * 这里按缩进做一次轻量行扫描（js-yaml 不暴露 AST，引 `yaml` 包只为行号不值当）：
 * - `id/name/label` 的值 → 行号，按文档顺序消耗，重复 id 的第二次拿到第二行；
 * - `nodes/edges/...` 下的 `- ` 项 → 行号，按顺序消耗，报错能指到具体那条连线。
 */
export interface LineIndex {
  /** 按标量值取行号（消耗式：第二次取同名值给第二处） */
  at(value: string): number | undefined;
  /** 某个 key 第一次出现的行号 */
  key(key: string): number | undefined;
  /** 某个序列（nodes/edges…）的下一项行号，按文档顺序消耗 */
  nextSeq(key: string): number | undefined;
}

export function buildLineIndex(text: string): LineIndex {
  const lines = text.split(/\r?\n/);
  const byValue = new Map<string, number[]>();
  const byKey = new Map<string, number[]>();
  const seq = new Map<string, number[]>();
  const usedValue = new Map<string, number>();
  const usedSeq = new Map<string, number>();
  const stack: Array<{ indent: number; key: string }> = [];

  const push = (m: Map<string, number[]>, k: string, v: number) => {
    if (!k) return;
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '');
    if (!line.trim()) continue;
    const ind = (line.match(/^\s*/) as RegExpMatchArray)[0].length;

    if (/^\s*-(\s|$)/.test(line)) {
      const parent = stack.length ? stack[stack.length - 1].key : '';
      push(seq, parent, i + 1);
      const inline = line.match(/(?:^|[{\s,])(id|name|label)\s*:\s*([^,}]+)/);
      if (inline) push(byValue, unquote(inline[2]), i + 1);
      continue;
    }

    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
    const key = kv[1];
    const val = kv[2].trim();
    push(byKey, key, i + 1);
    if (val) {
      if (['id', 'name', 'label'].includes(key) && !/^[[{]/.test(val)) push(byValue, unquote(val), i + 1);
    } else {
      stack.push({ indent: ind, key });
    }
  }

  return {
    at(value: string) {
      const arr = byValue.get(value);
      if (arr?.length) {
        const k = usedValue.get(value) ?? 0;
        usedValue.set(value, k + 1);
        return arr[Math.min(k, arr.length - 1)];
      }
      const i = lines.findIndex((l) => l.includes(value));
      return i >= 0 ? i + 1 : undefined;
    },
    key(k: string) {
      return byKey.get(k)?.[0];
    },
    nextSeq(k: string) {
      const arr = seq.get(k);
      if (!arr?.length) return undefined;
      const i = usedSeq.get(k) ?? 0;
      usedSeq.set(k, i + 1);
      return arr[i] ?? arr[arr.length - 1];
    },
  };
}

function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function normSide(v: unknown, fallback: Side = 'l'): Side {
  const s = asString(v);
  if (!s) return fallback;
  return SIDES[s.trim().toLowerCase()] ?? SIDES[s.trim()] ?? fallback;
}

/** 解析 "l:clk,vs,hs | r:dout" / ["clk","rst"] / {left:[...],right:[...]} */
function normPorts(raw: unknown, diags: Diagnostic[]): Port[] {
  const out: Port[] = [];
  // 端口名后缀表示方向：`clk` 默认按边推断，`data>` 出框，`bus<>` 双向；
  // 对象写法 {name, dir: input|output|inout} 显式指定，优先级更高
  const push = (name: string, side: Side, explicitDir?: Port['dir'], explicitWidth?: string) => {
    let nm = name.trim();
    let dir: Port['dir'] | undefined = explicitDir;
    if (!dir && nm.endsWith('<>')) {
      dir = 'both';
      nm = nm.slice(0, -2).trim();
    } else if (!dir && nm.endsWith('>')) {
      dir = 'out';
      nm = nm.slice(0, -1).trim();
    } else if (!dir && nm.endsWith('<')) {
      dir = 'in';
      nm = nm.slice(0, -1).trim();
    }
    // 位宽：显式 width 优先；否则从端口名末尾的 [19:0] / [7] 自动提取，
    // 并从显示名里剥掉，避免位宽在框上重复画一遍。
    let width = explicitWidth?.trim() || undefined;
    const wm = nm.match(/^(.+?)\[(\d+:\d+|\d+)\]$/);
    if (wm) {
      nm = wm[1].trim();
      width = width ?? wm[2];
    }
    if (!nm) return;
    // 以前这里静默丢弃：`l:clk | r:clk` 只剩一个端口，图上少一根线也不报
    if (out.some((p) => p.name === nm)) {
      diags.push({ severity: 'warning', message: `端口 "${nm}" 重复声明，后一个已忽略` });
      return;
    }
    out.push({ id: nm, name: nm, side, ...(dir ? { dir } : {}), ...(width ? { width } : {}) });
  };

  if (typeof raw === 'string') {
    for (const chunk of raw.split('|')) {
      const m = chunk.match(/^\s*([A-Za-z\u4e00-\u9fa5]+)\s*[::]\s*(.*)$/);
      if (m && SIDES[m[1].trim().toLowerCase()]) {
        const side = normSide(m[1]);
        for (const nm of m[2].split(/[,，;；\s]+/)) push(nm, side);
      } else {
        for (const nm of chunk.split(/[,，;；\s]+/)) push(nm, 'l');
      }
    }
    return out;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        const m = item.match(/^([A-Za-z\u4e00-\u9fa5]+)\s*[::]\s*(.+)$/);
        if (m && SIDES[m[1].trim().toLowerCase()]) push(m[2], normSide(m[1]));
        else push(item, 'l');
      } else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        push(
          asString(o.name) ?? asString(o.id) ?? '',
          normSide(o.side),
          normalizeDir(o.dir ?? o.direction),
          asString(o.width) ?? asString(o.bits),
        );
      }
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const side = normSide(k, 'l');
      const list = Array.isArray(v) ? v : String(v).split(/[,，\s]+/);
      for (const nm of list) push(asString(nm) ?? '', side);
    }
  }
  return out;
}

/**
 * 拆 `节点.端口`。端口名允许带位宽/下标，如 `awaddr[19:0]`、`din[7]`：
 * FPGA 里端口按位切片连线是常态，正则必须放行 `[ ] : ( )`。
 */
function splitEndpoint(s: string): { node: string; port?: string } {
  const t = s.trim();
  const m = t.match(/^(.+?)\.([A-Za-z0-9_\u4e00-\u9fa5[\]():]+)$/);
  if (m) return { node: m[1].trim(), port: m[2].trim() };
  return { node: t };
}

/** 在括号外找标签分隔符 `:`，避免把 `awaddr[19:0]` 里的冒号当成标签起点 */
function splitLabel(rest: string): { head: string; label?: string } {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    else if ((ch === ':' || ch === '：') && depth === 0) {
      return { head: rest.slice(0, i).trim(), label: rest.slice(i + 1).trim() };
    }
  }
  return { head: rest.trim() };
}

const STYLE_KV = /^(style|route|样式|路由)[:=](.+)$/i;

/**
 * 拆标签里的样式/路由词。
 * - 显式写法 `style:bus` / `route:curve` 永远优先；
 * - 裸词（bus/clk/ctrl…）只在"标签整串就这一个词"时当样式，
 *   否则 `A -> B : clk 32bit` 里的 clk 会被静默吃掉——那是信号名，不是样式。
 */
function parseEdgeLabel(raw: string): { label?: string; style?: EdgeStyle; route?: EdgeRoute } {
  const words = raw.split(/\s+/).filter(Boolean);
  const keep: string[] = [];
  let style: EdgeStyle | undefined;
  let route: EdgeRoute | undefined;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const kv = w.match(STYLE_KV);
    if (!kv) {
      keep.push(w);
      continue;
    }
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if (!val && i + 1 < words.length) val = words[++i];
    const low = val.toLowerCase();
    if (key === 'route' || key === '路由') route = ROUTE_WORDS[low] ?? ROUTE_WORDS[val] ?? route;
    else style = STYLE_WORDS[low] ?? STYLE_WORDS[val] ?? style;
  }

  if (!style && !route && keep.length === 1) {
    const k = keep[0];
    const s = STYLE_WORDS[k.toLowerCase()] ?? STYLE_WORDS[k];
    const r = ROUTE_WORDS[k.toLowerCase()] ?? ROUTE_WORDS[k];
    if (s) return { style: s };
    if (r) return { route: r };
  }
  const text = keep.join(' ').trim();
  if (!text || text === '""' || text === "''") return { style, route };
  return { label: text, style, route };
}

/** v2: 解析手工拐点 [[x,y], ...]，支持对象 {x,y} 写法 */
function normWaypoints(raw: unknown): [number, number][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const pts: [number, number][] = [];
  for (const p of raw) {
    if (Array.isArray(p) && p.length >= 2) {
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
    } else if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>;
      const x = Number(o.x);
      const y = Number(o.y);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
    }
  }
  return pts.length ? pts : undefined;
}

/** v2: 解析连线视觉覆盖 {stroke, strokeWidth, dashed, color} */
function normEdgeVisual(raw: unknown): DiagramEdge['visual'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const v: NonNullable<DiagramEdge['visual']> = {};
  if (asString(o.stroke)) v.stroke = asString(o.stroke);
  if (asString(o.color)) v.color = asString(o.color);
  if (Number(o.strokeWidth) > 0) v.strokeWidth = Number(o.strokeWidth);
  if (o.dashed === true) v.dashed = true;
  return Object.keys(v).length ? v : undefined;
}

function parseEdgeString(raw: string): Partial<DiagramEdge> | null {
  // 长箭头放前面，否则 `-->` 会被 `--` 抢先匹配成无箭头
  const m = raw.match(/^(.+?)\s*(<->|-->|->|--|→)\s*(.+)$/);
  if (!m) return null;
  const arrow: DiagramEdge['arrow'] = m[2] === '<->' ? 'both' : m[2] === '--' ? 'none' : 'end';
  const from = splitEndpoint(m[1]);
  const { head, label: rawLabel } = splitLabel(m[3].trim());
  const to = splitEndpoint(head);
  const { label, style, route } = rawLabel ? parseEdgeLabel(rawLabel) : { label: undefined };
  return {
    from: { node: from.node, port: from.port },
    to: { node: to.node, port: to.port },
    label,
    style: style ?? 'wire',
    route: route ?? 'orth',
    arrow,
  };
}

function normValues(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).trim();
      if (s === '.' || s === '..' || s === '-') return '';
      return s;
    });
  }
  const s = asString(raw);
  if (!s) return [];
  const t = s.trim();
  if (!/[\s,|]/.test(t) && /^[01zxZX.]+$/.test(t) && t.length > 1) {
    return [...t].map((c) => (c === '.' ? '' : c.toLowerCase()));
  }
  return t.split(/[\s,|]+/).map((x) => (x === '.' || x === '..' || x === '-' ? '' : x.toLowerCase() === 'z' || x.toLowerCase() === 'x' ? x.toLowerCase() : x));
}

const MIN_STEPS = 4;
const MAX_STEPS = 512;

function normSteps(raw: unknown, rows: TimingRow[], fallback = 16, diags?: Diagnostic[]): number {
  let steps = Number(raw ?? 0) || 0;
  for (const r of rows) steps = Math.max(steps, r.values.length);
  if (steps > MAX_STEPS && diags) {
    diags.push({ severity: 'warning', message: `时序格数 ${steps} 超过上限 ${MAX_STEPS}，已截断` });
  }
  return Math.min(MAX_STEPS, Math.max(MIN_STEPS, steps || fallback));
}

function padRows(rows: TimingRow[], steps: number): void {
  for (const r of rows) {
    while (r.values.length < steps) r.values.push('');
    r.values.length = steps;
  }
}

/**
 * 校验信号颜色。颜色会直接进 SVG 的 stroke/fill 属性，必须挡住带引号或尖括号的值，
 * 否则等于给 .fpgad 开了一个往 webview 注入标签的口子。
 */
const COLOR_RE = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%deg/]+\))$/i;

function normColor(v: unknown, name: string, diags: Diagnostic[]): string | undefined {
  const s = asString(v)?.trim();
  if (!s) return undefined;
  if (!COLOR_RE.test(s)) {
    diags.push({ severity: 'warning', message: `信号 "${name}" 的颜色 "${s}" 无法识别，已忽略（支持 #rgb / #rrggbb / 颜色名）` });
    return undefined;
  }
  return s;
}

/** 解析一条信号（时钟 / 单比特 / 总线 / 分组标题） */
function makeRow(o: Record<string, any>, diags: Diagnostic[]): TimingRow | null {
  const name = asString(o.name) ?? asString(o.id) ?? '';
  if (!name) {
    diags.push({ severity: 'warning', message: '有一行信号缺少 name，已跳过' });
    return null;
  }
  warnUnknownKeys(o, ROW_KEYS, `信号 "${name}"`, diags);
  let type = String(o.type ?? 'logic').toLowerCase();
  if (['clk', '时钟'].includes(type)) type = 'clock';
  if (['bus', '总线', 'data'].includes(type)) type = 'bus';
  if (['group', '分组', 'header', '组'].includes(type)) type = 'group';
  if (!['clock', 'logic', 'bus', 'group'].includes(type)) type = 'logic';
  const row: TimingRow = {
    name,
    type: type as TimingRow['type'],
    values: normValues(o.values ?? o.value ?? o.wave),
    color: normColor(o.color ?? o.colour, name, diags),
  };
  if (asString(o.width) || asString(o.bits)) row.width = (asString(o.width) ?? asString(o.bits)) as string;
  if (o.order !== undefined && Number.isFinite(Number(o.order))) row.order = Number(o.order);
  if (row.type === 'clock') {
    const freq = Number(o.freq ?? o.mhz ?? o.frequency ?? 0) || 0;
    if (freq > 0) row.freq = freq;
    row.period = Math.max(2, Number(o.period ?? 0) || 2);
    row.duty = Math.min(0.95, Math.max(0.05, Number(o.duty ?? 0.5)));
    row.phase = Number(o.phase ?? 0) || 0;
    row.values = [];
  }
  if (row.type === 'group') {
    row.values = [];
    // v2: group 的子信号递归解析
    const rawKids = o.children ?? o.signals;
    if (Array.isArray(rawKids)) {
      const kids: TimingRow[] = [];
      for (const k of rawKids) {
        if (!k || typeof k !== 'object') continue;
        const kid = makeRow(k as Record<string, any>, diags);
        if (kid) kids.push(kid);
      }
      if (kids.length) row.children = kids;
    }
  }
  return row;
}

/** 解析一组时序面板：panels[i] 自带 steps / signals */
function parsePanel(o: Record<string, any>, diags: Diagnostic[], fallbackSteps = 16, root = false): TimingPanel {
  // 根上的单组时序已经由"文件 / 图纸"两层查过字段，这里不再重复报
  if (!root) warnUnknownKeys(o, PANEL_KEYS, '时序组', diags);
  const rows = (Array.isArray(o.signals ?? o.rows ?? o.waveforms) ? (o.signals ?? o.rows ?? o.waveforms) : []) as unknown[];
  const panel: TimingPanel = { steps: fallbackSteps, rows: [] };
  const title = asString(o.title) ?? asString(o.name);
  if (title) panel.title = title;
  for (const r of rows) {
    if (typeof r === 'string') {
      panel.rows.push({ name: r, type: 'logic', values: [] });
      continue;
    }
    if (!r || typeof r !== 'object') continue;
    const row = makeRow(r as Record<string, any>, diags);
    if (row) panel.rows.push(row);
  }
  // 同名信号会让"改一条"变成"改错一条"，尤其在 AI 生成的文件里
  const seen = new Map<string, number>();
  for (const r of panel.rows) seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
  for (const [name, cnt] of seen) {
    if (cnt > 1) diags.push({ severity: 'warning', message: `同一组里信号名 "${name}" 重复 ${cnt} 次，可能有一行不会被看清` });
  }
  panel.steps = normSteps(o.steps, panel.rows, fallbackSteps, diags);
  padRows(panel.rows, panel.steps);
  return panel;
}

function parseTiming(d: Record<string, any>, diagram: Diagram, diags: Diagnostic[]): void {
  const rawPanels = d.panels ?? d.groups ?? d.views;
  if (Array.isArray(rawPanels) && rawPanels.length) {
    for (const p of rawPanels) {
      if (!p || typeof p !== 'object') continue;
      diagram.panels.push(parsePanel(p as Record<string, any>, diags));
    }
  } else if (d.panels !== undefined) {
    diags.push({ severity: 'error', message: 'panels 必须是非空列表' });
  }
  if (!diagram.panels.length) {
    diagram.panels.push(parsePanel(d, diags, 16, true));
  }
  if (!diagram.panels.some((p) => p.rows.length)) {
    // 允许空图（新建时序图），不当作错误
  }
}

/**
 * 网格 / 时钟周期 / 组时长三者必须对得上，否则图会自相矛盾：
 * 100 MHz（10 ns/周期）配 tick 5 画 16 格，标题却写「16 拍」，而计数只有 8 拍。
 */
function checkTimingGrid(d: Diagram, diags: Diagnostic[]): void {
  // 只检查用户自己写的 tick：tickAuto 是工具挑的，替工具的选择报错没意义
  if (!(d.tick && d.tick > 0)) return;
  d.panels.forEach((panel, i) => {
    const st = timingStats(d, panel);
    if (!st.hasClock) return;
    const where = panel.title ? `「${panel.title}」` : `第 ${i + 1} 组`;
    const cpb = st.cellsPerBeat;
    const half = st.beatNs / 2;
    if (cpb < 1 - 1e-9) {
      diags.push({
        severity: 'warning',
        message: `时序组${where}：网格 ${numText(st.tick)} ns 比时钟周期 ${numText(st.beatNs)} ns 还粗，一个周期不到一格，时钟会被挤成锯齿；把 tick 改成 ${numText(half)} 左右`,
      });
      return;
    }
    if (Math.abs(cpb - Math.round(cpb)) > 1e-3) {
      diags.push({
        severity: 'warning',
        message: `时序组${where}：时钟周期 ${numText(st.beatNs)} ns 不是网格 ${numText(st.tick)} ns 的整数倍（${cpb.toFixed(2)} 格/周期），时钟沿会落在格子中间、计数拍和竖线对不齐；建议 tick: ${numText(half)}`,
      });
      return;
    }
    if (Math.abs(st.beats - Math.round(st.beats)) > 1e-3) {
      diags.push({
        severity: 'warning',
        message: `时序组${where}：${panel.steps} 格 × ${numText(st.tick)} ns = ${numText(st.spanNs)} ns，不到整数拍（${st.beats.toFixed(2)} 拍），最后一拍会被画断；把 steps 调到 ${Math.round(st.spanNs / st.beatNs) * Math.round(cpb)} 左右`,
      });
    }
  });
}

/** 把一个已 load 的 YAML 映射解析成一张图 */
function parseSceneObject(d: Record<string, any>, hintKind: Kind | undefined, diags: Diagnostic[], idx: LineIndex): Diagram {
  warnUnknownKeys(d, SCENE_KEYS, '图纸', diags, idx.key('kind') ?? idx.key('diagram_type'));
  // diagram_type 是新增的顶层绘图类型声明；旧文件只有 kind，也继续认。
  // 两者都没有时按内容推断，保持老图纸的兼容行为。
  const typeRaw = d.diagram_type ?? d.diagramType ?? d.kind;
  const declared = resolveKind(typeRaw);
  const kind: Kind =
    declared ??
    (d.states
      ? 'fsm'
      : d.signals || d.panels
        ? 'timing'
        : hintKind ?? 'system_block');
  if (typeRaw && !declared) {
    diags.push({
      severity: 'warning',
      message: `未知绘图类型 "${typeRaw}"，按 ${kind} 处理（可选 system_block / datapath / fsm / timing；旧 block / schematic 仍兼容）`,
      line: idx.key('diagram_type') ?? idx.key('kind'),
    });
  }
  const diagram = emptyDiagram(kind);
  diagram.kind = kind;
  if (asString(d.id)) diagram.id = asString(d.id);
  diagram.title = asString(d.title);

  const opt = (d.options ?? {}) as Record<string, any>;
  // v2: layout 可以是对象 {strategy, direction, nodeSpacing, layerSpacing}；旧写法是字符串
  let layoutObj: Record<string, any> = {};
  if (d.layout && typeof d.layout === 'object' && !Array.isArray(d.layout)) layoutObj = d.layout as Record<string, any>;
  const dir = String(layoutObj.direction ?? opt.direction ?? d.direction ?? 'LR').toUpperCase();
  diagram.options.direction =
    dir === 'TB' || dir === 'TD' ? 'TB' : dir === 'RL' ? 'RL' : dir === 'BT' ? 'BT' : 'LR';
  const lay = String(layoutObj.strategy ?? layoutObj.layout ?? opt.strategy ?? opt.layout ?? (typeof d.layout === 'string' ? d.layout : 'auto'));
  diagram.options.layout = (['auto', 'layered', 'circular', 'grid', 'manual', 'sugiyama', 'force'].includes(lay)
    ? lay
    : 'auto') as typeof diagram.options.layout;
  if (Number(layoutObj.nodeSpacing) > 0) diagram.options.nodeSpacing = Number(layoutObj.nodeSpacing);
  else if (Number(opt.nodeSpacing) > 0) diagram.options.nodeSpacing = Number(opt.nodeSpacing);
  if (Number(layoutObj.layerSpacing) > 0) diagram.options.layerSpacing = Number(layoutObj.layerSpacing);
  else if (Number(opt.layerSpacing) > 0) diagram.options.layerSpacing = Number(opt.layerSpacing);
  const tick = Number(d.tick ?? d.tickNs ?? 0) || 0;
  if (tick > 0) diagram.tick = tick;

  if (kind === 'timing') {
    parseTiming(d, diagram, diags);
    syncClockFreqs(diagram);
    checkTimingGrid(diagram, diags);
    return diagram;
  }

  // ---- nodes ----
  const rawNodes = d.nodes ?? d.states ?? d.modules ?? [];
  const pushNode = (line: number | undefined, rawId: string, o: Record<string, any>) => {
    const node = makeNode(rawId, kind, o, diags, line);
    if (kind === 'system_block' && isLowLevelType(node.type)) {
      diags.push({
        severity: 'warning',
        message: `[规范提示] ${LOW_LEVEL_TYPES[node.type]}属于底层原理图组件，不建议在系统框图中使用`,
        line,
      });
    }
    diagram.nodes.push(node);
  };
  if (!Array.isArray(rawNodes)) {
    diags.push({ severity: 'error', message: 'nodes 必须是列表' });
  } else {
    for (const item of rawNodes) {
      if (typeof item === 'string') {
        pushNode(idx.at(item), item, {});
        continue;
      }
      if (!item || typeof item !== 'object') {
        diags.push({ severity: 'warning', message: 'nodes 中有一项不是映射，已跳过' });
        continue;
      }
      const o = item as Record<string, any>;
      const id = asString(o.id) ?? asString(o.name) ?? asString(o.label);
      if (!id) {
        diags.push({ severity: 'error', message: '有一个节点缺少 id（需 id / name / label 之一），已跳过' });
        continue;
      }
      // 消耗一次行号游标：重复 id 的第二次才会拿到第二处行号
      const idLine = idx.at(id);
      if (diagram.nodes.some((nd) => nd.id === id)) {
        diags.push({ severity: 'error', message: `节点 id 重复："${id}"，后者已忽略`, line: idLine });
        continue;
      }
      pushNode(idLine, id, o);
    }
  }

  // ---- edges ----
  const edgeKey = Array.isArray(d.edges) ? 'edges' : Array.isArray(d.transitions) ? 'transitions' : Array.isArray(d.links) ? 'links' : 'edges';
  const rawEdges = d.edges ?? d.transitions ?? d.links ?? [];
  if (!Array.isArray(rawEdges)) {
    diags.push({ severity: 'error', message: 'edges 必须是列表' });
  } else {
    // 老文件里节点不写 ports、连线只写 .dout 的情况很常见：
    // 每个节点只提示一次，别让 4 条线刷 8 条一样的警告。
    const implicitWarned = new Set<string>();
    rawEdges.forEach((item, i) => {
      // 每条连线按文档顺序消费一个行号，报错才能指到这一条而不是文件里第一处
      const edgeLine = idx.nextSeq(edgeKey);
      let partial: Partial<DiagramEdge> | null = null;
      if (typeof item === 'string') {
        partial = parseEdgeString(item);
        if (!partial) {
          diags.push({ severity: 'error', message: `无法解析连线（应写成 A -> B）："${item}"` });
          return;
        }
      } else if (item && typeof item === 'object') {
        const o = item as Record<string, any>;
        const keys = Object.keys(o);
        // YAML 会把 `- a -> b : label` 解析成单键映射，这里还原成字符串形式
        if (!o.from && !o.source && keys.length === 1 && keys[0].includes('->')) {
          const label = o[keys[0]];
          const rebuilt =
            label === undefined || label === null || typeof label === 'object'
              ? keys[0]
              : `${keys[0]} : ${label}`;
          partial = parseEdgeString(rebuilt);
          if (!partial) {
            diags.push({ severity: 'error', message: `无法解析连线（应写成 A -> B）："${rebuilt}"` });
            return;
          }
        } else {
          warnUnknownKeys(o, EDGE_KEYS, '连线', diags, edgeLine);
          const from = typeof o.from === 'string' ? splitEndpoint(o.from) : { node: asString(o.from?.node) ?? asString(o.source) ?? '', port: asString(o.from?.port) ?? asString(o.from_port), side: o.from?.side };
          const to = typeof o.to === 'string' ? splitEndpoint(o.to) : { node: asString(o.to?.node) ?? asString(o.target) ?? '', port: asString(o.to?.port) ?? asString(o.to_port), side: o.to?.side };
          // style 旧写法是字符串（wire/bus/...），v2 是视觉对象；两者可同时出现
          const edgeStyle = typeof o.style === 'string' ? (STYLE_WORDS[o.style.toLowerCase()] ?? 'wire') : 'wire';
          const visual = normEdgeVisual(typeof o.style === 'object' ? o.style : o.visual);
          partial = {
            from: { node: from.node, port: from.port, side: (from as any).side ? normSide((from as any).side) : undefined },
            to: { node: to.node, port: to.port, side: (to as any).side ? normSide((to as any).side) : undefined },
            label: asString(o.label) ?? asString(o.text),
            action: asString(o.action),
            style: edgeStyle as EdgeStyle,
            route: (ROUTE_WORDS[String(o.route ?? '').toLowerCase()] ?? 'orth') as EdgeRoute,
            arrow: o.arrow === 'both' ? 'both' : o.arrow === 'none' ? 'none' : 'end',
            ...(normWaypoints(o.waypoints) ? { waypoints: normWaypoints(o.waypoints) } : {}),
            ...(visual ? { visual } : {}),
          };
        }
      }
      if (!partial || !partial.from?.node || !partial.to?.node) return;

      const known = diagram.nodes.map((x) => x.id);
      if (!diagram.nodes.some((nd) => nd.id === partial!.from!.node)) {
        diags.push({
          severity: 'error',
          message: `连线引用了不存在的节点 "${partial.from.node}"（可用节点：${known.join(', ')}）`,
          line: edgeLine,
        });
        return;
      }
      if (!diagram.nodes.some((nd) => nd.id === partial!.to!.node)) {
        diags.push({
          severity: 'error',
          message: `连线引用了不存在的节点 "${partial.to.node}"（可用节点：${known.join(', ')}）`,
          line: edgeLine,
        });
        return;
      }

      // 端口存在性 / 所在边校验：端口名写错过去会静默退化成"边中点"，
      // 图上看着有线，实际电气连接是错的。
      const checkPort = (nd: DiagramNode, ref: string | undefined, side: Side | undefined, end: '起点' | '终点') => {
        if (!ref) return;
        const p = portByRef(nd, ref);
        if (!p) {
          const declared = nd.ports.map((x) => x.name);
          const near = nearestKey(ref.replace(/\[[^\]]*\]$/, ''), new Set(declared));
          const msg = declared.length
            ? `连线${end}引用了 "${nd.id}" 上不存在的端口 "${ref}"（该节点端口：${declared.join(', ')}${near ? `；是否想写 "${near}"` : ''}）`
            : `连线${end}引用了端口 "${ref}"，但节点 "${nd.id}" 没有声明任何端口`;
          if (!declared.length && implicitWarned.has(nd.id)) return;
          if (!declared.length) implicitWarned.add(nd.id);
          diags.push({ severity: declared.length ? 'error' : 'warning', message: msg, line: edgeLine });
          return;
        }
        if (side && side !== p.side) {
          diags.push({
            severity: 'warning',
            message: `端口 "${p.name}" 在 ${SIDE_CN[p.side]}，连线写的是 ${SIDE_CN[side]}；已按端口实际所在边绘制`,
            line: edgeLine,
          });
        }
      };
      checkPort(diagram.nodes.find((nd) => nd.id === partial!.from!.node)!, partial.from.port, partial.from.side, '起点');
      checkPort(diagram.nodes.find((nd) => nd.id === partial!.to!.node)!, partial.to.port, partial.to.side, '终点');

      diagram.edges.push({
        id: `e${i}`,
        from: partial.from,
        to: partial.to,
        label: partial.label,
        action: partial.action,
        style: partial.style ?? 'wire',
        route: partial.route ?? 'orth',
        arrow: partial.arrow ?? 'end',
        ...(partial.waypoints ? { waypoints: partial.waypoints } : {}),
        ...(partial.visual ? { visual: partial.visual } : {}),
      });
    });
  }

  if (!diagram.nodes.length) {
    diags.push({ severity: 'warning', message: '没有解析到任何节点，检查 nodes 字段' });
  }
  return diagram;
}

/**
 * 解析整份文件：单图文件（diagram_type / kind）或多视图文件（scenes: [...]）。
 * 多视图让"框图 / 状态机 / 多组时序"共存在同一个 .fpgad 里，切换页签不丢内容。
 */
export function parseFile(text: string, hintKind?: Kind): ParseFileResult {
  const diagnostics: Diagnostic[] = [];
  const src = (text ?? '').trim();
  if (!src) {
    return { file: { scenes: [emptyDiagram(hintKind ?? 'system_block')], active: 0 }, diagnostics };
  }
  let doc: any;
  try {
    doc = src.startsWith('{') || src.startsWith('[') ? JSON.parse(src) : yaml.load(src, { schema: yaml.CORE_SCHEMA });
  } catch (e: any) {
    const line = e?.mark?.line !== undefined ? e.mark.line + 1 : e?.lineNumber;
    diagnostics.push({ severity: 'error', message: `语法错误：${e?.reason ?? e?.message ?? String(e)}`, line });
    return { file: { scenes: [emptyDiagram(hintKind ?? 'system_block')], active: 0 }, diagnostics };
  }
  if (!doc || typeof doc !== 'object') {
    diagnostics.push({ severity: 'error', message: '文件内容不是有效的映射（需要 kind: 开头）' });
    return { file: { scenes: [emptyDiagram(hintKind ?? 'system_block')], active: 0 }, diagnostics };
  }

  const d = doc as Record<string, any>;
  warnUnknownKeys(d, FILE_KEYS, '文件', diagnostics, 1);
  // 用未 trim 的原文建索引，否则开头的空行会把所有行号整体偏移
  const idx = buildLineIndex(text);

  // v2 文档头：version / meta / options（都是可选，缺了就是 v1 形态）
  const version = asString(d.version);
  const metaRaw = d.meta && typeof d.meta === 'object' ? (d.meta as Record<string, any>) : undefined;
  const meta = metaRaw
    ? {
        ...(asString(metaRaw.title) ? { title: asString(metaRaw.title) } : {}),
        ...(asString(metaRaw.author) ? { author: asString(metaRaw.author) } : {}),
        ...(asString(metaRaw.created) ? { created: asString(metaRaw.created) } : {}),
        ...(asString(metaRaw.modified) ? { modified: asString(metaRaw.modified) } : {}),
      }
    : undefined;
  const goptRaw = d.options && typeof d.options === 'object' ? (d.options as Record<string, any>) : undefined;
  const gopt = goptRaw
    ? {
        ...(goptRaw.grid !== undefined ? { grid: !!goptRaw.grid } : {}),
        ...(Number(goptRaw.gridSize) > 0 ? { gridSize: Number(goptRaw.gridSize) } : {}),
        ...(goptRaw.snapToGrid !== undefined ? { snapToGrid: !!goptRaw.snapToGrid } : {}),
        ...(asString(goptRaw.fontFamily) ? { fontFamily: asString(goptRaw.fontFamily) } : {}),
        ...(Number(goptRaw.fontSize) > 0 ? { fontSize: Number(goptRaw.fontSize) } : {}),
      }
    : undefined;
  const header = {
    ...(version ? { version } : {}),
    ...(meta && Object.keys(meta).length ? { meta } : {}),
    ...(gopt && Object.keys(gopt).length ? { options: gopt } : {}),
  };

  if (Array.isArray(d.scenes)) {
    const scenes: Diagram[] = [];
    d.scenes.forEach((s: any, i: number) => {
      if (!s || typeof s !== 'object') {
        diagnostics.push({ severity: 'warning', message: `scenes[${i}] 不是映射，已跳过` });
        return;
      }
      const scene = parseSceneObject(s as Record<string, any>, hintKind, diagnostics, idx);
      if (!scene.id) scene.id = `${scene.kind}-${i + 1}`;
      scenes.push(scene);
    });
    if (!scenes.length) {
      diagnostics.push({ severity: 'warning', message: 'scenes 是空的，已放入一张空框图' });
      scenes.push(emptyDiagram(hintKind ?? 'system_block'));
    }
    let active = Number(d.active ?? 0) || 0;
    if (active < 0 || active >= scenes.length) active = 0;
    return { file: { scenes, active, ...header }, diagnostics: dedupeDiagnostics(diagnostics) };
  }

  const scene = parseSceneObject(d, hintKind, diagnostics, idx);
  return { file: { scenes: [scene], active: 0, ...header }, diagnostics: dedupeDiagnostics(diagnostics) };
}

/**
 * 单图文件的根对象同时被"文件 / 图纸 / 时序组"三层检查，
 * 同一个笔误会报三遍；按 内容+行号 去重，保留一条就够。
 */
function dedupeDiagnostics(diags: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diags.filter((d) => {
    const field = /字段 "([^"]+)"/.exec(d.message)?.[1];
    const key = field ? `f|${d.line ?? ''}|${field}` : `m|${d.severity}|${d.line ?? ''}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 兼容接口：只取当前激活的那张图 */
export function parseDiagram(text: string, hintKind?: Kind): ParseResult {
  const { file, diagnostics } = parseFile(text, hintKind);
  return { diagram: file.scenes[file.active] ?? file.scenes[0], diagnostics };
}

function makeNode(id: string, kind: Kind, o: Record<string, any>, diags: Diagnostic[], line?: number): DiagramNode {
  warnUnknownKeys(o, NODE_KEYS, `节点 "${id}"`, diags, line);
  const rawType = asString(o.type) ?? asString(o.shape);
  if (rawType && !isKnownType(rawType, kind)) {
    diags.push({
      severity: 'warning',
      message: `节点 "${id}" 的类型 "${rawType}" 无法识别，已按 ${kind === 'fsm' ? '状态' : '模块'} 处理`,
      line,
    });
  }
  const type = resolveType(rawType, kind);
  const shape = shapeOf(type, kind);
  let w = shape.w;
  let h = shape.h;
  // 只有文件里显式写了 size 才算"固定尺寸"；否则交给布局按文字自适应。
  // 布局层看到 size 就完全照用，不再按文字回弹（拖边框改尺寸才不会被吃掉）。
  let fixedSize: [number, number] | undefined;
  if (Array.isArray(o.size) && o.size.length >= 2) {
    w = Number(o.size[0]) || w;
    h = Number(o.size[1]) || h;
    fixedSize = [w, h];
  }
  let pos: [number, number] | undefined;
  if (Array.isArray(o.pos) && o.pos.length >= 2) {
    pos = [Number(o.pos[0]) || 0, Number(o.pos[1]) || 0];
  } else if (o.x !== undefined && o.y !== undefined) {
    pos = [Number(o.x) || 0, Number(o.y) || 0];
  }
  const children = Array.isArray(o.children) ? o.children.map((c: unknown) => asString(c) ?? '') : undefined;
  const frameStyle = String(o.style ?? o.frame ?? '').toLowerCase();
  // v2: style 可以是对象 {fill, stroke, dashed, ...}；旧写法 style: dashed 仍认
  let style: DiagramNode['style'] | undefined;
  if (o.style && typeof o.style === 'object' && !Array.isArray(o.style)) {
    const so = o.style as Record<string, unknown>;
    style = {
      ...(asString(so.fill) ? { fill: asString(so.fill) } : {}),
      ...(asString(so.stroke) ? { stroke: asString(so.stroke) } : {}),
      ...(Number(so.strokeWidth) > 0 ? { strokeWidth: Number(so.strokeWidth) } : {}),
      ...(asString(so.textColor) ? { textColor: asString(so.textColor) } : {}),
      ...(so.dashed === true ? { dashed: true } : {}),
    };
    if (!Object.keys(style).length) style = undefined;
  }
  const dashed = o.dash === true || frameStyle === 'dashed' || style?.dashed === true;
  return {
    id,
    type,
    label: asString(o.label) ?? asString(o.name) ?? (o.label === '' ? '' : id),
    sub: asString(o.sub) ?? asString(o.note),
    x: pos?.[0] ?? 0,
    y: pos?.[1] ?? 0,
    w,
    h,
    pos,
    ...(fixedSize ? { size: fixedSize } : {}),
    ports: normPorts(o.ports ?? o.io, diags),
    children: children?.filter(Boolean),
    ...(dashed ? { dash: true } : {}),
    ...(String(o.titlePos ?? o.titlepos ?? '').toLowerCase() === 'br' || String(o.titlePos ?? '').toLowerCase() === 'bottom'
      ? { titlePos: 'br' as const }
      : {}),
    ...(style ? { style } : {}),
    ...(o.collapsed === true ? { collapsed: true } : {}),
    ...(o.data && typeof o.data === 'object' ? { data: o.data as Record<string, unknown> } : {}),
  };
}
