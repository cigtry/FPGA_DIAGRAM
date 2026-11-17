import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BUS_GROUPS, assignSides, expandBusGroup, suggestNodeSize } from '../src/core/busGroups';
import { Port } from '../src/core/model';

describe('AXI 标准信号组', () => {
  it('三套模板的信号数与关键信号', () => {
    const byId = Object.fromEntries(BUS_GROUPS.map((g) => [g.id, g]));
    assert.equal(byId.axi4lite.signals.length, 19);
    assert.equal(byId.axi4stream.signals.length, 8);
    assert.equal(byId.axi4full.signals.length, 35);
    assert.ok(byId.axi4lite.signals.some((s) => s.name === 'AWVALID' && s.dir === 'out'));
    assert.ok(byId.axi4lite.signals.some((s) => s.name === 'RREADY' && s.dir === 'out'));
    assert.ok(byId.axi4stream.signals.some((s) => s.name === 'TLAST'));
    assert.ok(byId.axi4full.signals.some((s) => s.name === 'AWBURST'));
    assert.ok(byId.axi4full.signals.some((s) => s.name === 'RLAST' && s.dir === 'in'));
  });

  it('master / slave 方向翻转', () => {
    const m = expandBusGroup('axi4lite', 'master');
    const s = expandBusGroup('axi4lite', 'slave');
    const aw = (ps: Port[]) => ps.find((p) => p.name === 'AWVALID')!.dir;
    const awready = (ps: Port[]) => ps.find((p) => p.name === 'AWREADY')!.dir;
    assert.equal(aw(m), 'out');
    assert.equal(awready(m), 'in');
    assert.equal(aw(s), 'in');
    assert.equal(awready(s), 'out');
  });

  it('前缀与端口名', () => {
    const ps = expandBusGroup('axi4stream', 'master', 's_');
    assert.equal(ps[0].name, 's_TVALID');
    assert.equal(ps[0].id, 's_TVALID');
    assert.ok(ps.every((p) => p.name.startsWith('s_')));
  });

  it('展开结果就是普通端口，没有模板私有字段', () => {
    const p = expandBusGroup('axi4lite')[0];
    assert.deepEqual(Object.keys(p).sort(), ['dir', 'id', 'name', 'side']);
  });

  it('自动均匀分配到四边并给出足够的节点尺寸', () => {
    const ps = expandBusGroup('axi4full');
    const sides = new Set(ps.map((p) => p.side));
    assert.equal(sides.size, 4);
    const counts = ['l', 'r', 't', 'b'].map((s) => ps.filter((p) => p.side === s).length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `分布不均：${counts}`);
    const [w, h] = suggestNodeSize(ps, [152, 78]);
    assert.ok(w > 152 && h > 78);
  });

  it('assignSides 按方向优先：input 靠左、output 靠右', () => {
    const ps: Port[] = [
      { id: 'a', name: 'a', side: 'b', dir: 'in' },
      { id: 'b', name: 'b', side: 'b', dir: 'out' },
    ];
    assignSides(ps);
    assert.equal(ps[0].side, 'l');
    assert.equal(ps[1].side, 'r');
  });
});
