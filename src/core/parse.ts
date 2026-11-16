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
  emptyDiagram,
  resolveType,
  shapeOf,
  syncClockFreqs,
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
  // 端口名后缀表示方向：`clk` 默认按边推断，`data>` 出框，`bus<>` 双向
  const push = (name: string, side: Side) => {
    let nm = name.trim();
    let dir: Port['dir'];
    if (nm.endsWith('<>')) {
      dir = 'both';
      nm = nm.slice(0, -2).trim();
    } else if (nm.endsWith('>')) {
      dir = 'out';
      nm = nm.slice(0, -1).trim();
    } else if (nm.endsWith('<')) {
      dir = 'in';
      nm = nm.slice(0, -1).trim();
    }
    if (!nm) return;
    if (out.some((p) => p.name === nm)) return;
    out.push({ id: nm, name: nm, side, ...(dir ? { dir } : {}) });
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
        push(asString(o.name) ?? asString(o.id) ?? '', normSide(o.side));
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

function normSteps(raw: unknown, rows: TimingRow[], fallback = 16): number {
  let steps = Number(raw ?? 0) || 0;
  for (const r of rows) steps = Math.max(steps, r.values.length);
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
  if (row.type === 'clock') {
    const freq = Number(o.freq ?? o.mhz ?? o.frequency ?? 0) || 0;
    if (freq > 0) row.freq = freq;
    row.period = Math.max(2, Number(o.period ?? 0) || 2);
    row.duty = Math.min(0.95, Math.max(0.05, Number(o.duty ?? 0.5)));
    row.phase = Number(o.phase ?? 0) || 0;
    row.values = [];
  }
  if (row.type === 'group') row.values = [];
  return row;
}

/** 解析一组时序面板：panels[i] 自带 steps / signals */
function parsePanel(o: Record<string, any>, diags: Diagnostic[], fallbackSteps = 16): TimingPanel {
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
  panel.steps = normSteps(o.steps, panel.rows, fallbackSteps);
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
    diagram.panels.push(parsePanel(d, diags));
  }
  if (!diagram.panels.some((p) => p.rows.length)) {
    // 允许空图（新建时序图），不当作错误
  }
}

/** 把一个已 load 的 YAML 映射解析成一张图 */
function parseSceneObject(d: Record<string, any>, hintKind: Kind | undefined, diags: Diagnostic[], idx: LineIndex): Diagram {
  let kind: Kind =
    d.kind === 'fsm' || d.kind === 'timing' || d.kind === 'block'
      ? d.kind
      : d.states
        ? 'fsm'
        : d.signals || d.panels
          ? 'timing'
          : hintKind ?? 'block';
  if (d.kind && !['block', 'fsm', 'timing'].includes(String(d.kind))) {
    diags.push({ severity: 'warning', message: `未知 kind "${d.kind}"，按 ${kind} 处理（可选 block / fsm / timing）` });
  }
  const diagram = emptyDiagram(kind);
  diagram.kind = kind;
  if (asString(d.id)) diagram.id = asString(d.id);
  diagram.title = asString(d.title);

  const opt = (d.options ?? {}) as Record<string, any>;
  const dir = String(opt.direction ?? d.direction ?? 'LR').toUpperCase();
  diagram.options.direction = dir === 'TB' || dir === 'TD' ? 'TB' : 'LR';
  const lay = String(opt.layout ?? d.layout ?? 'auto');
  diagram.options.layout = ['auto', 'layered', 'circular', 'manual'].includes(lay) ? (lay as any) : 'auto';
  const tick = Number(d.tick ?? d.tickNs ?? 0) || 0;
  if (tick > 0) diagram.tick = tick;

  if (kind === 'timing') {
    parseTiming(d, diagram, diags);
    syncClockFreqs(diagram);
    return diagram;
  }

  // ---- nodes ----
  const rawNodes = d.nodes ?? d.states ?? d.modules ?? [];
  if (!Array.isArray(rawNodes)) {
    diags.push({ severity: 'error', message: 'nodes 必须是列表' });
  } else {
    for (const item of rawNodes) {
      if (typeof item === 'string') {
        diagram.nodes.push(makeNode(item, kind, {}, diags));
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
      diagram.nodes.push(makeNode(id, kind, o, diags));
    }
  }

  // ---- edges ----
  const edgeKey = Array.isArray(d.edges) ? 'edges' : Array.isArray(d.transitions) ? 'transitions' : Array.isArray(d.links) ? 'links' : 'edges';
  const rawEdges = d.edges ?? d.transitions ?? d.links ?? [];
  if (!Array.isArray(rawEdges)) {
    diags.push({ severity: 'error', message: 'edges 必须是列表' });
  } else {
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
          const from = typeof o.from === 'string' ? splitEndpoint(o.from) : { node: asString(o.from?.node) ?? asString(o.source) ?? '', port: asString(o.from?.port) ?? asString(o.from_port), side: o.from?.side };
          const to = typeof o.to === 'string' ? splitEndpoint(o.to) : { node: asString(o.to?.node) ?? asString(o.target) ?? '', port: asString(o.to?.port) ?? asString(o.to_port), side: o.to?.side };
          partial = {
            from: { node: from.node, port: from.port, side: (from as any).side ? normSide((from as any).side) : undefined },
            to: { node: to.node, port: to.port, side: (to as any).side ? normSide((to as any).side) : undefined },
            label: asString(o.label) ?? asString(o.text),
            action: asString(o.action),
            style: (STYLE_WORDS[String(o.style ?? '').toLowerCase()] ?? 'wire') as EdgeStyle,
            route: (ROUTE_WORDS[String(o.route ?? '').toLowerCase()] ?? 'orth') as EdgeRoute,
            arrow: o.arrow === 'both' ? 'both' : o.arrow === 'none' ? 'none' : 'end',
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
      diagram.edges.push({
        id: `e${i}`,
        from: partial.from,
        to: partial.to,
        label: partial.label,
        action: partial.action,
        style: partial.style ?? 'wire',
        route: partial.route ?? 'orth',
        arrow: partial.arrow ?? 'end',
      });
    });
  }

  if (!diagram.nodes.length) {
    diags.push({ severity: 'warning', message: '没有解析到任何节点，检查 nodes 字段' });
  }
  return diagram;
}

/**
 * 解析整份文件：单图文件（kind: block/fsm/timing）或多视图文件（scenes: [...]）。
 * 多视图让"框图 / 状态机 / 多组时序"共存在同一个 .fpgad 里，切换页签不丢内容。
 */
export function parseFile(text: string, hintKind?: Kind): ParseFileResult {
  const diagnostics: Diagnostic[] = [];
  const src = (text ?? '').trim();
  if (!src) {
    return { file: { scenes: [emptyDiagram(hintKind ?? 'block')], active: 0 }, diagnostics };
  }
  let doc: any;
  try {
    doc = src.startsWith('{') || src.startsWith('[') ? JSON.parse(src) : yaml.load(src, { schema: yaml.CORE_SCHEMA });
  } catch (e: any) {
    const line = e?.mark?.line !== undefined ? e.mark.line + 1 : e?.lineNumber;
    diagnostics.push({ severity: 'error', message: `语法错误：${e?.reason ?? e?.message ?? String(e)}`, line });
    return { file: { scenes: [emptyDiagram(hintKind ?? 'block')], active: 0 }, diagnostics };
  }
  if (!doc || typeof doc !== 'object') {
    diagnostics.push({ severity: 'error', message: '文件内容不是有效的映射（需要 kind: 开头）' });
    return { file: { scenes: [emptyDiagram(hintKind ?? 'block')], active: 0 }, diagnostics };
  }

  const d = doc as Record<string, any>;
  // 用未 trim 的原文建索引，否则开头的空行会把所有行号整体偏移
  const idx = buildLineIndex(text);
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
      scenes.push(emptyDiagram(hintKind ?? 'block'));
    }
    let active = Number(d.active ?? 0) || 0;
    if (active < 0 || active >= scenes.length) active = 0;
    return { file: { scenes, active }, diagnostics };
  }

  const scene = parseSceneObject(d, hintKind, diagnostics, idx);
  return { file: { scenes: [scene], active: 0 }, diagnostics };
}

/** 兼容接口：只取当前激活的那张图 */
export function parseDiagram(text: string, hintKind?: Kind): ParseResult {
  const { file, diagnostics } = parseFile(text, hintKind);
  return { diagram: file.scenes[file.active] ?? file.scenes[0], diagnostics };
}

function makeNode(id: string, kind: Kind, o: Record<string, any>, diags: Diagnostic[]): DiagramNode {
  const type = resolveType(asString(o.type) ?? asString(o.shape), kind);
  const shape = shapeOf(type, kind);
  let w = shape.w;
  let h = shape.h;
  if (Array.isArray(o.size) && o.size.length >= 2) {
    w = Number(o.size[0]) || w;
    h = Number(o.size[1]) || h;
  }
  let pos: [number, number] | undefined;
  if (Array.isArray(o.pos) && o.pos.length >= 2) {
    pos = [Number(o.pos[0]) || 0, Number(o.pos[1]) || 0];
  } else if (o.x !== undefined && o.y !== undefined) {
    pos = [Number(o.x) || 0, Number(o.y) || 0];
  }
  const children = Array.isArray(o.children) ? o.children.map((c: unknown) => asString(c) ?? '') : undefined;
  const frameStyle = String(o.style ?? o.frame ?? '').toLowerCase();
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
    size: [w, h],
    ports: normPorts(o.ports ?? o.io, diags),
    children: children?.filter(Boolean),
    ...(o.dash === true || frameStyle === 'dashed' ? { dash: true } : {}),
    ...(String(o.titlePos ?? o.titlepos ?? '').toLowerCase() === 'br' || String(o.titlePos ?? '').toLowerCase() === 'bottom'
      ? { titlePos: 'br' as const }
      : {}),
  };
}
