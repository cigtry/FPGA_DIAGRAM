import { Port, Side } from './model';

/**
 * FPGA 常用标准总线信号组。
 * 这里只是 DSL 文本模板的数据源：展开后就是普通 Port，没有任何私有格式，
 * 用户可以再逐个改名、改方向、删除，和手写端口完全等价。
 */

export type BusGroupId = 'axi4lite' | 'axi4stream' | 'axi4full';
export type BusRole = 'master' | 'slave';

export interface BusSignal {
  name: string;
  /** master 视角的方向 */
  dir: 'in' | 'out';
}

export interface BusGroupDef {
  id: BusGroupId;
  cn: string;
  desc: string;
  signals: BusSignal[];
}

const sig = (names: string, dir: 'in' | 'out'): BusSignal[] =>
  names.split(/\s+/).filter(Boolean).map((name) => ({ name, dir }));

export const BUS_GROUPS: BusGroupDef[] = [
  {
    id: 'axi4lite',
    cn: 'AXI4-Lite',
    desc: '19 信号 · 低带宽寄存器访问',
    signals: [
      ...sig('AWVALID AWADDR AWPROT', 'out'), ...sig('AWREADY', 'in'),
      ...sig('WVALID WDATA WSTRB', 'out'), ...sig('WREADY', 'in'),
      ...sig('BVALID BRESP', 'in'), ...sig('BREADY', 'out'),
      ...sig('ARVALID ARADDR ARPROT', 'out'), ...sig('ARREADY', 'in'),
      ...sig('RVALID RDATA RRESP', 'in'), ...sig('RREADY', 'out'),
    ],
  },
  {
    id: 'axi4stream',
    cn: 'AXI4-Stream',
    desc: '8 信号 · 单向数据流',
    signals: [
      ...sig('TVALID TDATA TKEEP TLAST TID TDEST TUSER', 'out'),
      ...sig('TREADY', 'in'),
    ],
  },
  {
    id: 'axi4full',
    cn: 'AXI4-Full',
    desc: '35 信号 · 突发传输',
    signals: [
      ...sig('AWVALID AWADDR AWLEN AWSIZE AWBURST AWLOCK AWCACHE AWPROT AWQOS AWREGION', 'out'),
      ...sig('AWREADY', 'in'),
      ...sig('WVALID WDATA WSTRB WLAST', 'out'), ...sig('WREADY', 'in'),
      ...sig('BVALID BRESP', 'in'), ...sig('BREADY', 'out'),
      ...sig('ARVALID ARADDR ARLEN ARSIZE ARBURST ARLOCK ARCACHE ARPROT ARQOS ARREGION', 'out'),
      ...sig('ARREADY', 'in'),
      ...sig('RVALID RDATA RRESP RLAST', 'in'), ...sig('RREADY', 'out'),
    ],
  },
];

export function busGroup(id: string): BusGroupDef | undefined {
  return BUS_GROUPS.find((g) => g.id === id);
}

const ALL_SIDES: Side[] = ['l', 'r', 't', 'b'];

/** 端口太多时不要全塞在一条边上，按方向优先再均匀分流到其余三边 */
export function assignSides(ports: Port[]): void {
  const counts: Record<Side, number> = { l: 0, r: 0, t: 0, b: 0 };
  const fallback: Record<'in' | 'out' | 'both', Side[]> = {
    in: ['l', 't', 'b', 'r'],
    out: ['r', 't', 'b', 'l'],
    both: ['b', 't', 'l', 'r'],
  };
  const max = Math.max(4, Math.ceil(ports.length / 4));
  for (const p of ports) {
    const order = fallback[p.dir ?? 'in'];
    // 首选边满了就找最空的一边，绝不让溢出端口全堆在 l
    const side = order.find((s) => counts[s] < max)
      ?? ALL_SIDES.slice().sort((a, b) => counts[a] - counts[b])[0];
    p.side = side;
    counts[side] += 1;
  }
}

/** 每边端口太多时按此放大节点，避免标签互相压住（UI 插入信号组后用） */
export function suggestNodeSize(ports: Port[], base: [number, number]): [number, number] {
  const counts: Record<Side, number> = { l: 0, r: 0, t: 0, b: 0 };
  for (const p of ports) counts[p.side] += 1;
  const perSide = (s1: Side, s2: Side) => Math.max(counts[s1], counts[s2]);
  return [
    Math.max(base[0], perSide('t', 'b') * 20 + 60),
    Math.max(base[1], perSide('l', 'r') * 20 + 40),
  ];
}

/**
 * 展开成一组可直接塞进 DiagramNode.ports 的端口。
 * role=slave 时所有方向翻转；prefix 常用 `m_` / `s_` / `axi_` 区分多组接口。
 */
export function expandBusGroup(id: BusGroupId, role: BusRole = 'master', prefix = ''): Port[] {
  const group = busGroup(id);
  if (!group) return [];
  const pre = prefix.trim();
  const ports: Port[] = group.signals.map((s) => {
    const dir = role === 'slave' && s.dir === 'out' ? 'in' : role === 'slave' && s.dir === 'in' ? 'out' : s.dir;
    const name = `${pre}${s.name}`;
    return { id: name, name, side: 'l', dir };
  });
  assignSides(ports);
  return ports;
}
