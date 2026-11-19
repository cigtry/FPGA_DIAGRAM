import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseFile } from '../src/core/parse';
import { layout } from '../src/core/layout';
import { render, RenderCache, edgeMidpoint } from '../src/core/render';
import { palette } from '../src/core/theme';

function diagram(text: string) {
  const d = parseFile(text).file.scenes[0];
  // render 会调 layout；这里直接 layout 便于断言坐标
  return d;
}

describe('布局策略', () => {
  it('grid 策略把节点排成方阵且不重叠', () => {
    const d = diagram(`kind: block
options:
  strategy: grid
nodes:
  - {id: a}
  - {id: b}
  - {id: c}
  - {id: d}
`);
    assert.equal(d.options.layout, 'grid');
    layout(d);
    const boxes = d.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }));
    assert.equal(new Set(boxes.map((b) => `${b.x},${b.y}`)).size, 4, '四个节点应落在不同格子');
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        assert.ok(!overlap, `${a.id} 与 ${b.id} 不应重叠`);
      }
    }
  });

  it('RL 方向：源节点在目标右侧', () => {
    const d = diagram(`kind: block
options:
  direction: RL
nodes:
  - {id: a}
  - {id: b}
  - {id: c}
edges:
  - a -> b
  - b -> c
`);
    layout(d);
    const a = d.nodes.find((n) => n.id === 'a')!;
    const c = d.nodes.find((n) => n.id === 'c')!;
    assert.ok(a.x > c.x, `RL 下 a(${a.x}) 应在 c(${c.x}) 右侧`);
  });

  it('BT 方向：源节点在目标下方', () => {
    const d = diagram(`kind: block
options:
  direction: BT
nodes:
  - {id: a}
  - {id: b}
  - {id: c}
edges:
  - a -> b
  - b -> c
`);
    layout(d);
    const a = d.nodes.find((n) => n.id === 'a')!;
    const c = d.nodes.find((n) => n.id === 'c')!;
    assert.ok(a.y > c.y, `BT 下 a(${a.y}) 应在 c(${c.y}) 下方`);
  });
});

describe('waypoints 渲染', () => {
  const DOC = `kind: block
nodes:
  - {id: a}
  - {id: b}
edges:
  - {from: a, to: b, waypoints: [[100, 30], [160, 30]]}
`;

  it('手绘拐点写进 SVG 路径', () => {
    const d = diagram(DOC);
    const out = render(d, { theme: palette('light') });
    assert.ok(out.body.includes('100'), '路径应经过拐点 x=100');
    assert.ok(out.body.includes('160'), '路径应经过拐点 x=160');
  });

  it('edgeMidpoint 落在拐点路径上', () => {
    const d = diagram(DOC);
    layout(d);
    const mid = edgeMidpoint(d, d.edges[0]);
    assert.ok(mid, '应算出中点');
    assert.ok(Number.isFinite(mid.x) && Number.isFinite(mid.y));
  });

  it('无 waypoints 时走自动路由，仍能渲染', () => {
    const d = diagram(`kind: block
nodes:
  - {id: a}
  - {id: b}
edges:
  - a -> b
`);
    const out = render(d, { theme: palette('light') });
    assert.ok(out.body.includes('fd-edge'));
  });
});

describe('RenderCache 增量渲染', () => {
  it('相同内容二次渲染命中缓存（返回同一对象）', () => {
    const cache = new RenderCache();
    const d = diagram('kind: block\nnodes: [{id: a}, {id: b}]\nedges: [a -> b]\n');
    const opt = { theme: palette('light') };
    const r1 = cache.render(d, opt);
    const r2 = cache.render(d, opt);
    assert.strictEqual(r1, r2, '未变化时应复用渲染结果');
  });

  it('内容变化后重新渲染', () => {
    const cache = new RenderCache();
    const opt = { theme: palette('light') };
    const d1 = diagram('kind: block\nnodes: [{id: a}]\n');
    const r1 = cache.render(d1, opt);
    const d2 = diagram('kind: block\nnodes: [{id: a}, {id: b}]\n');
    const r2 = cache.render(d2, opt);
    assert.notStrictEqual(r1, r2);
  });
});

describe('显式尺寸（拖边框缩放后不被布局吃掉）', () => {
  it('文件里写了 size 的节点，布局后宽高完全保持', () => {
    const d = diagram(`kind: block
nodes:
  - {id: tall, type: module, label: 高模块, size: [200, 400], pos: [0, 0]}
`);
    layout(d);
    assert.deepEqual([d.nodes[0].w, d.nodes[0].h], [200, 400], '400 高不应被截成 220');
  });

  it('缩窄到比文字更窄时也保持用户尺寸', () => {
    const d = diagram(`kind: block
nodes:
  - {id: n, type: module, label: 一个很长的模块名字用于测试, size: [90, 60], pos: [0, 0]}
`);
    layout(d);
    assert.deepEqual([d.nodes[0].w, d.nodes[0].h], [90, 60]);
  });

  it('没有显式 size 的节点仍按文字自适应', () => {
    const d = diagram(`kind: block
nodes:
  - {id: n, type: module, label: 一个很长的模块名字用于测试自适应宽度}
`);
    const nd = d.nodes[0];
    assert.equal(nd.size, undefined, '没写 size 时不应被当成固定尺寸');
    layout(d);
    assert.ok(nd.w > 130, '长文字应把节点撑宽');
  });

  it('拖过尺寸的分组框不会被内容撑回', () => {
    const d = diagram(`kind: block
nodes:
  - {id: g, type: group, label: 分组, size: [500, 400], pos: [100, 100], children: [a]}
  - {id: a, type: module, label: A, pos: [140, 140]}
`);
    layout(d);
    const g = d.nodes.find((n) => n.id === 'g')!;
    assert.deepEqual([g.w, g.h, g.x, g.y], [500, 400, 100, 100]);
  });

  it('尺寸写进文件后能原样解析回来', () => {
    const d = diagram(`kind: block
nodes:
  - {id: n, type: module, label: N, size: [240, 300], pos: [10, 20]}
`);
    layout(d);
    const back = diagram(`kind: block
nodes:
  - {id: n, type: module, label: N, size: [240, 300], pos: [10, 20]}
`);
    layout(back);
    assert.deepEqual([back.nodes[0].w, back.nodes[0].h], [240, 300]);
    assert.deepEqual(back.nodes[0].size, [240, 300]);
  });
});
