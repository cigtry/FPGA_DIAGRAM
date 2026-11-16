export type Kind = 'block' | 'fsm' | 'timing';
export type Side = 'l' | 'r' | 't' | 'b';

export interface Port {
  id: string;
  name: string;
  side: Side;
  /** 框边界端口的方向：进框 / 出框 / 双向（默认按所在边推断） */
  dir?: 'in' | 'out' | 'both';
}

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
}

export type LogicValue = '0' | '1' | 'z' | 'x';

export interface TimingRow {
  name: string;
  type: 'clock' | 'logic' | 'bus' | 'group';
  /** 时钟周期，单位=拍（step）。由 freq 换算得到 */
  period?: number;
  /** 时钟频率（MHz）。写了 freq 就按频率算周期，多时钟系统靠它对齐 */
  freq?: number;
  duty?: number;
  phase?: number;
  /** logic: 0/1/z/x；bus: 每格的总线值（'' 表示保持上一段） */
  values: string[];
  color?: string;
}

/**
 * 一组时序：自带拍数与时间轴。
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
  /** 时间基准：每拍多少 ns（timing 专用，默认 10） */
  tick?: number;
  options: {
    direction: 'LR' | 'TB';
    layout: 'auto' | 'layered' | 'circular' | 'manual';
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

export function resolveType(raw: string | undefined, kind: Kind): string {
  const key = (raw ?? '').trim();
  const low = key.toLowerCase();
  if (ALIASES[low]) return ALIASES[low];
  if (ALIASES[key]) return ALIASES[key];
  const table = kind === 'fsm' ? FSM_SHAPES : BLOCK_SHAPES;
  if (table[low]) return low;
  return kind === 'fsm' ? 'state' : 'module';
}

export function shapeOf(type: string, kind: Kind): ShapeDef {
  return (kind === 'fsm' ? FSM_SHAPES[type] : BLOCK_SHAPES[type]) ??
    (kind === 'fsm' ? FSM_SHAPES.state : BLOCK_SHAPES.module);
}

export function emptyDiagram(kind: Kind): Diagram {
  return {
    kind,
    nodes: [],
    edges: [],
    panels: [],
    tick: 10,
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

/** 多视图文件：一个 .fpgad 可以装若干张图，页签切换，互不覆盖内容 */
export interface SceneFile {
  scenes: Diagram[];
  active: number;
}

export const KIND_LABEL: Record<Kind, string> = {
  block: '系统框图',
  fsm: '状态机',
  timing: '时序图',
};

/** 时序图摘要：多组时序时把组数也报出来 */
export function timingSummary(d: Diagram): string {
  const rows = d.panels.reduce((s, p) => s + p.rows.length, 0);
  const steps = d.panels.reduce((s, p) => s + p.steps, 0);
  return d.panels.length > 1 ? `${d.panels.length} 组 / ${rows} 条信号 / ${steps} 拍` : `${rows} 条信号 / ${steps} 拍`;
}

/**
 * 让频率说了算：所有写了 freq 的时钟按 ns 换算成"拍"。
 * 网格分辨率取最快时钟的半周期，这样 100MHz 与 50MHz 叠在同一张图上不会错位。
 */
export function syncClockFreqs(d: Diagram): void {
  const clocks = d.panels.flatMap((p) => p.rows).filter((r) => r.type === 'clock' && (r.freq ?? 0) > 0);
  if (!clocks.length) return;
  const minNs = Math.min(...clocks.map((r) => 1000 / (r.freq as number)));
  const base = d.tick && d.tick > 0 ? d.tick : 10;
  const tick = Math.max(0.1, Math.min(base, minNs / 2));
  d.tick = Number(tick.toFixed(2));
  for (const r of clocks) {
    const ns = 1000 / (r.freq as number);
    let steps = Math.max(2, Math.round(ns / d.tick));
    if (steps % 2) steps += 1;
    r.period = steps;
  }
}
