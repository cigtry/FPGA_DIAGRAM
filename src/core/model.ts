/**
 * block 是旧文件的兼容类型（全组件、不告警）；
 * system_block 系统框图、schematic/datapath 底层原理图或数据通路、fsm 状态机、timing 时序。
 * datapath 是 v2 设计稿引入的叫法，组件表与 schematic 完全一致。
 */
export type Kind = 'block' | 'system_block' | 'schematic' | 'datapath' | 'fsm' | 'timing';
export type Side = 'l' | 'r' | 't' | 'b';
export type PortDir = 'in' | 'out' | 'both';

export interface Port {
  id: string;
  name: string;
  side: Side;
  /** 进框 / 出框 / 双向。DSL 后缀 `<` / `>` / `<>`，等价于 input / output / inout */
  dir?: PortDir;
  /** 位宽标注，如 `32` / `[19:0]` / `8`。渲染在端口名旁 */
  width?: string;
}

/**
 * 位宽后缀：`32` → `[31:0]`，`[19:0]` 原样，`8` → `[7:0]`。
 * 端口和时序总线共用，保证图上记法一致。
 */
export function widthSuffix(width?: string): string {
  const w = (width ?? '').trim();
  if (!w) return '';
  if (w.startsWith('[')) return w;
  const bits = Number(w);
  if (Number.isFinite(bits) && bits > 0) return `[${bits > 1 ? `${bits - 1}:0` : '0'}]`;
  return `[${w}]`;
}

/**
 * 端口在图上显示的文字：`awaddr[19:0]`。
 * 位宽是 FPGA 框图里最该出现的信息之一，之前解析了却从来没画出来。
 */
export function portLabel(p: Port): string {
  return `${p.name}${widthSuffix(p.width)}`;
}

/** v2 节点样式覆盖（DSL NodeStyle） */
export interface NodeStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  textColor?: string;
  dashed?: boolean;
}

/** v2 连线视觉覆盖（DSL EdgeDef.style 对象形式） */
export interface EdgeVisual {
  stroke?: string;
  strokeWidth?: number;
  dashed?: boolean;
  color?: string;
}

export type Point = [number, number];

/** 手工拐点；存在时渲染优先于自动路由 */
export type Waypoints = Point[];

export interface DiagramNode {
  id: string;
  type: string;
  label: string;
  sub?: string;
  /** 自动布局算出的绝对坐标；若存在 pos 则以 pos 为准 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 用户在画布上拖动后写回的固定坐标 */
  pos?: [number, number];
  size?: [number, number];
  ports: Port[];
  children?: string[];
  /** frame 专用：虚线边框 */
  dash?: boolean;
  /** frame 专用：标题位置，默认顶部居中 */
  titlePos?: 'top' | 'br';
  /** 折叠状态（frame/group 用） */
  collapsed?: boolean;
  /** v2 样式覆盖 */
  style?: NodeStyle;
  /** 自定义扩展数据 */
  data?: Record<string, unknown>;
  /** 时序图行（timing 专用） */
  row?: TimingRow;
}

export interface Endpoint {
  node: string;
  port?: string;
  side?: Side;
}

export type EdgeStyle = 'wire' | 'bus' | 'clock' | 'ctrl';
export type EdgeRoute = 'orth' | 'straight' | 'curve';

export interface DiagramEdge {
  id: string;
  from: Endpoint;
  to: Endpoint;
  label?: string;
  style: EdgeStyle;
  route: EdgeRoute;
  arrow: 'end' | 'both' | 'none';
  /** 转移上的条件 / 动作，用于状态机 */
  action?: string;
  /** v2 手工拐点；有值时覆盖自动路由 */
  waypoints?: Waypoints;
  /** v2 视觉覆盖 */
  visual?: EdgeVisual;
}

export type LogicValue = '0' | '1' | 'z' | 'x';

export interface TimingRow {
  name: string;
  type: 'clock' | 'logic' | 'bus' | 'group';
  /** 时钟周期，单位=格（step）。没写 freq 时按它画 */
  period?: number;
  /** 时钟真实周期（ns）。由 freq 换算，渲染按它画沿，不再量化到整数格 */
  periodNs?: number;
  /** 时钟频率（MHz）。写了 freq 就按频率算周期，多时钟系统靠它对齐 */
  freq?: number;
  duty?: number;
  phase?: number;
  /** logic: 0/1/z/x；bus: 每格的总线值（'' 表示保持上一段） */
  values: string[];
  color?: string;
  /** bus 位宽，如 32 / "[19:0]" */
  width?: string;
  /** 显式排序值；未写时按数组顺序。拖拽重排后写回顺序 */
  order?: number;
  /** group 类型的子信号 */
  children?: TimingRow[];
}

/**
 * 一组时序：自带格数（网格列数）与时间轴。
 * 同一张图里可以有多组（写通道 / 读通道 / 复位时序…），纵向排在同一画布上。
 */
export interface TimingPanel {
  title?: string;
  steps: number;
  rows: TimingRow[];
}

export interface Diagram {
  /** 多视图文件里的视图标识 */
  id?: string;
  kind: Kind;
  title?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** timing 专用；非 timing 为空数组 */
  panels: TimingPanel[];
  /** 时间基准：每格多少 ns（timing 专用）。用户显式写 tick 时才有值 */
  tick?: number;
  /**
   * 由最快时钟推导出的显示用时间基准（每格 ns）。
   * 只进内存、不序列化：fmt / save 不会把它写回文件，
   * 否则用户文件里的 tick 会被悄悄改成 3.37 这种推导值。
   */
  tickAuto?: number;
  options: {
    direction: 'LR' | 'TB' | 'RL' | 'BT';
    layout: 'auto' | 'layered' | 'circular' | 'grid' | 'manual' | 'sugiyama' | 'force';
    nodeSpacing?: number;
    layerSpacing?: number;
  };
  /** 解析期收集的问题，仅在渲染时忽略 */
  warnings: string[];
}

export interface ShapeDef {
  /** 默认宽度 */
  w: number;
  h: number;
  /** 中文名，用于面板与错误提示 */
  cn: string;
}

/** FPGA 常用图形集合 —— 刻意不做通用图形库 */
export const BLOCK_SHAPES: Record<string, ShapeDef> = {
  module: { w: 152, h: 78, cn: '模块' },
  reg: { w: 132, h: 74, cn: '寄存器' },
  adder: { w: 112, h: 72, cn: '加法器' },
  mult: { w: 112, h: 72, cn: '乘法器' },
  mux: { w: 108, h: 78, cn: '多路选择' },
  fifo: { w: 124, h: 72, cn: 'FIFO' },
  ram: { w: 132, h: 82, cn: 'RAM/ROM' },
  clock: { w: 136, h: 72, cn: '时钟模块' },
  io: { w: 108, h: 50, cn: '输入输出' },
  note: { w: 148, h: 72, cn: '注释' },
  group: { w: 280, h: 170, cn: '分组框' },
  frame: { w: 360, h: 230, cn: '层次框' },
  diamond: { w: 124, h: 84, cn: '判断' },
};

/**
 * 系统框图白名单：功能模块、接口、层次框与注释。
 * 寄存器/加法器/乘法器/选择器/时钟原语属于微架构层，只有 schematic 才开放。
 */
export const SYSTEM_SHAPES: Record<string, ShapeDef> = {
  module: BLOCK_SHAPES.module,
  io: BLOCK_SHAPES.io,
  frame: BLOCK_SHAPES.frame,
  group: BLOCK_SHAPES.group,
  note: BLOCK_SHAPES.note,
  diamond: BLOCK_SHAPES.diamond,
};

/** 系统框图里出现这些组件时给规范提示（warning，不阻断渲染） */
export const LOW_LEVEL_TYPES: Record<string, string> = {
  reg: '寄存器',
  adder: '加法器',
  mult: '乘法器',
  mux: '多路选择器',
  clock: 'PLL / 时钟原语',
};

export function isLowLevelType(type: string): boolean {
  return type in LOW_LEVEL_TYPES;
}

/** 按视图类型取可用组件表 */
export function shapesFor(kind: Kind): Record<string, ShapeDef> {
  if (kind === 'fsm') return FSM_SHAPES;
  if (kind === 'system_block') return SYSTEM_SHAPES;
  return BLOCK_SHAPES; // block / schematic / datapath 都用全组件表
}

export const FSM_SHAPES: Record<string, ShapeDef> = {
  state: { w: 126, h: 66, cn: '状态' },
  init: { w: 26, h: 26, cn: '初始状态' },
  final: { w: 46, h: 46, cn: '结束状态' },
  junction: { w: 42, h: 42, cn: '判断节点' },
  group: { w: 280, h: 170, cn: '分组框' },
  frame: { w: 360, h: 230, cn: '层次框' },
};

const ALIASES: Record<string, string> = {
  // block
  模块: 'module',
  module: 'module',
  block: 'module',
  box: 'module',
  寄存器: 'reg',
  register: 'reg',
  ff: 'reg',
  触发器: 'reg',
  加法器: 'adder',
  add: 'adder',
  adder: 'adder',
  乘法器: 'mult',
  mul: 'mult',
  mult: 'mult',
  multiplier: 'mult',
  选择器: 'mux',
  多路选择: 'mux',
  mux: 'mux',
  fifo: 'fifo',
  缓存: 'fifo',
  存储器: 'ram',
  ram: 'ram',
  rom: 'rom',
  时钟: 'clock',
  clock: 'clock',
  端口: 'io',
  io: 'io',
  port: 'io',
  输入: 'io',
  输出: 'io',
  注释: 'note',
  note: 'note',
  分组: 'group',
  group: 'group',
  层次框: 'frame',
  框: 'frame',
  容器: 'frame',
  子模块: 'frame',
  frame: 'frame',
  container: 'frame',
  subblock: 'frame',
  region: 'frame',
  子图: 'group',
  判断: 'diamond',
  diamond: 'diamond',
  decision: 'diamond',
  // fsm
  状态: 'state',
  state: 'state',
  初始: 'init',
  init: 'init',
  start: 'init',
  结束: 'final',
  final: 'final',
  终态: 'final',
  junction: 'junction',
  choice: 'junction',
  分支: 'junction',
};

/** DSL 顶层类型别名（diagram_type / kind 都走这里） */
export const KIND_ALIASES: Record<string, Kind> = {
  block: 'block',
  hier: 'block',
  system: 'system_block',
  sys: 'system_block',
  system_block: 'system_block',
  systemblock: 'system_block',
  系统框图: 'system_block',
  schematic: 'schematic',
  sch: 'schematic',
  原理图: 'schematic',
  微架构: 'schematic',
  datapath: 'datapath',
  数据通路: 'datapath',
  dp: 'datapath',
  fsm: 'fsm',
  状态机: 'fsm',
  timing: 'timing',
  wave: 'timing',
  时序: 'timing',
};

export function resolveKind(raw: unknown): Kind | undefined {
  const s = String(raw ?? '').trim();
  return KIND_ALIASES[s.toLowerCase()] ?? KIND_ALIASES[s];
}

/** input/output/inout 与 `<`/`>`/`<>` 两套写法归一到内部值 */
export function normalizeDir(raw: unknown): PortDir | undefined {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (['in', 'input', '输入'].includes(s)) return 'in';
  if (['out', 'output', '输出'].includes(s)) return 'out';
  if (['both', 'inout', 'bidir', '双向'].includes(s)) return 'both';
  return undefined;
}

export function resolveType(raw: string | undefined, kind: Kind): string {
  const key = (raw ?? '').trim();
  const low = key.toLowerCase();
  if (ALIASES[low]) return ALIASES[low];
  if (ALIASES[key]) return ALIASES[key];
  const table = shapesFor(kind);
  if (table[low]) return low;
  return kind === 'fsm' ? 'state' : 'module';
}

/** 类型名是否真的存在（用于"未知类型"告警，避免静默降级成 module） */
export function isKnownType(raw: string | undefined, kind: Kind): boolean {
  const key = (raw ?? '').trim();
  if (!key) return true;
  const low = key.toLowerCase();
  return !!(
    ALIASES[low] ??
    ALIASES[key] ??
    shapesFor(kind)[low] ??
    BLOCK_SHAPES[low] ??
    SYSTEM_SHAPES[low] ??
    FSM_SHAPES[low]
  );
}

export function shapeOf(type: string, kind: Kind): ShapeDef {
  const table = shapesFor(kind);
  // 系统框图里写了底层组件时仍按原类型渲染，警告交给解析层，不让图变形
  const fallback = kind === 'fsm' ? FSM_SHAPES.state : kind === 'system_block' ? SYSTEM_SHAPES.module : BLOCK_SHAPES.module;
  return table[type] ?? BLOCK_SHAPES[type] ?? fallback;
}

export function emptyDiagram(kind: Kind): Diagram {
  return {
    kind,
    nodes: [],
    edges: [],
    panels: [],
    options: { direction: 'LR', layout: 'auto' },
    warnings: [],
  };
}

export function emptyTimingPanel(steps = 16): TimingPanel {
  return { steps, rows: [] };
}

export function nodeById(d: Diagram, id: string): DiagramNode | undefined {
  return d.nodes.find((n) => n.id === id);
}

/** v2 文档元数据 */
export interface DocMeta {
  title?: string;
  author?: string;
  created?: string;
  modified?: string;
}

/** v2 全局选项（文档级，非单张图） */
export interface GlobalOptions {
  grid?: boolean;
  gridSize?: number;
  snapToGrid?: boolean;
  fontFamily?: string;
  fontSize?: number;
}

/**
 * 多视图文件：一个 .fpgad 装若干张图，页签切换，互不覆盖内容。
 * v2 在此之上加 version / meta / options；这三个字段都是可选的，
 * 旧文件解析出来是 v1 形态，序列化时按需要决定写不写 v2 头。
 */
export interface SceneFile {
  scenes: Diagram[];
  active: number;
  version?: string;
  meta?: DocMeta;
  options?: GlobalOptions;
}

/**
 * 判断一份文档是否为 v2。
 * 只认显式的 `version` 字段：端口名里的 [19:0] 在 v1 里也会解析出 width，
 * 若把 width 当 v2 特征，旧图纸一存盘就被升成 v2 格式，往返测试与用户预期都会被破坏。
 * 想存成 v2 的旧图，在文件头写 `version: '2.0'` 即可显式升级。
 */
export function isV2(file: SceneFile): boolean {
  return !!file.version;
}

export const KIND_LABEL: Record<Kind, string> = {
  block: '框图',
  system_block: '系统框图',
  schematic: '原理图',
  datapath: '数据通路',
  fsm: '状态机',
  timing: '时序图',
};

/** 去掉多余小数：10 → "10"，6.734 → "6.73" */
export function numText(v: number, dp = 2): string {
  return String(Number(v.toFixed(dp)));
}

/**
 * 时序图摘要。单位必须分清：格是网格一列，拍是一个时钟周期。
 * 单组有时钟时报拍数与总时长，否则报格数——别把 16 格说成 16 拍。
 */
export function timingSummary(d: Diagram): string {
  const rows = d.panels.reduce((s, p) => s + p.rows.length, 0);
  const steps = d.panels.reduce((s, p) => s + p.steps, 0);
  const head = d.panels.length > 1 ? `${d.panels.length} 组 / ${rows} 条信号` : `${rows} 条信号`;
  if (d.panels.length === 1) {
    const st = timingStats(d, d.panels[0]);
    if (st.hasClock) return `${head} / ${numText(st.beats, 1)} 拍 · ${numText(st.spanNs)} ns`;
  }
  return `${head} / ${steps} 格`;
}

/**
 * 让频率说了算：所有写了 freq 的时钟记录真实周期（ns）。
 * 旧实现会把周期折成偶数拍，100 + 148.5 MHz 会把 100 MHz 画成 74 MHz；
 * 现在时间段用真实 ns，渲染按小数格画沿，频率关系不再失真。
 */
/** 推导显示用时间基准时优先选的"整数感"刻度（ns） */
const NICE_TICKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];

/**
 * 把时钟频率折算成真实周期，并推导一个显示用 tick。
 *
 * 旧实现把周期取整到偶数格、tick 再按最快时钟半周期量化，导致
 * 100 + 148.5 MHz 里 100 MHz 被画成 74.18 MHz（-25.8%），而且
 * 推导出的 tick 会被写回源文件。
 *
 * 现在：
 *  - `periodNs` 保存真实周期（1e3 / freq），渲染按 ns 画沿，不再量化；
 *  - `period` 仍按当前时间基准折算成格，供编辑面板显示；
 *  - 推导出的 tick 只放在 `tickAuto`，序列化永远不写它。
 */
export function syncClockFreqs(d: Diagram): void {
  const clocks = d.panels.flatMap((p) => p.rows).filter((r) => r.type === 'clock' && (r.freq ?? 0) > 0);
  if (!clocks.length) return;
  const periods = clocks.map((r) => 1000 / (r.freq as number));
  const minNs = Math.min(...periods);
  // 和旧行为一致：最快时钟约两格一个周期；tick 取整数感刻度，
  // 但周期本身不再量化，慢时钟靠真实 ns 画沿。
  const target = minNs / 2;
  let auto = NICE_TICKS[0];
  for (const v of NICE_TICKS) if (v <= target) auto = v;
  d.tickAuto = auto;
  const basis = tickOf(d);
  clocks.forEach((r) => {
    const ns = 1000 / (r.freq as number);
    r.periodNs = ns;
    r.period = Math.max(2, Math.round(ns / basis));
  });
}

/** 当前时间基准：用户显式 tick 优先，否则用最快时钟推导出的值 */
export function tickOf(d: Diagram): number {
  if (d.tick && d.tick > 0) return d.tick;
  if (d.tickAuto && d.tickAuto > 0) return d.tickAuto;
  return 10;
}

/** 一条时钟行的真实周期（ns）：freq 换算值优先，其次按 period × 网格 折算 */
export function clockPeriodNs(row: TimingRow, tick: number): number {
  if (row.type !== 'clock') return 0;
  if (row.periodNs && row.periodNs > 0) return row.periodNs;
  const beats = row.period && row.period > 0 ? row.period : 2;
  return beats * (tick > 0 ? tick : 10);
}

/** 组内最快时钟的周期（ns）；组里没有时钟时返回 0。分组内的子信号也算 */
export function panelBeatNs(panel: TimingPanel, tick: number): number {
  let best = 0;
  const walk = (rows: TimingRow[]): void => {
    for (const r of rows) {
      const ns = clockPeriodNs(r, tick);
      if (ns > 0 && (best === 0 || ns < best)) best = ns;
      if (r.children?.length) walk(r.children);
    }
  };
  walk(panel.rows);
  return best;
}

/**
 * 时序组的三个时间量，必须互相自洽：
 *  - `tick`   网格一列多少 ns（用户写 tick，或由最快时钟推导）
 *  - `beatNs` 一拍多少 ns。**一拍 = 一个时钟周期**；没有时钟的组里一拍 = 一格
 *  - `beats`  整组多少拍 = spanNs / beatNs
 *
 * 旧实现把"格"当"拍"来数标题（16 格 × 5 ns 写成「16 拍」），
 * 于是在 100 MHz（10 ns/周期）的组里画出 8 个计数拍却标 16 拍。
 */
export interface TimingStats {
  tick: number;
  spanNs: number;
  beatNs: number;
  beats: number;
  /** 一个时钟周期占几格；没有时钟时为 1。可能不是整数（如 148.5 MHz + 5 ns 网格） */
  cellsPerBeat: number;
  hasClock: boolean;
}

export function timingStats(d: Diagram, panel: TimingPanel): TimingStats {
  const tick = tickOf(d);
  const clockNs = panelBeatNs(panel, tick);
  const beatNs = clockNs > 0 ? clockNs : tick;
  const spanNs = panel.steps * tick;
  return {
    tick,
    spanNs,
    beatNs,
    beats: beatNs > 0 ? spanNs / beatNs : panel.steps,
    cellsPerBeat: beatNs > 0 ? beatNs / tick : 1,
    hasClock: clockNs > 0,
  };
}
