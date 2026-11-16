import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildLineIndex, parseFile } from '../src/core/parse';

/** 解析单图并返回第一个视图 + 诊断 */
function one(text: string) {
  const { file, diagnostics } = parseFile(text);
  return { d: file.scenes[0], diagnostics, file };
}

describe('端口位宽：node.awaddr[19:0] 必须能连线', () => {
  it('带 [ ] : 的端口名被正确拆分', () => {
    const text = `
kind: block
nodes:
  - {id: cpu, label: CPU, ports: "r: awaddr[19:0]"}
  - {id: ddr, label: DDR, ports: "l: awaddr[19:0]"}
edges:
  - cpu.awaddr[19:0] -> ddr.awaddr[19:0] : AXI4
`;
    const { d, diagnostics } = one(text);
    assert.deepEqual(
      diagnostics.filter((x) => x.severity === 'error'),
      [],
      '位宽端口连线不应报错',
    );
    assert.equal(d.edges.length, 1);
    assert.equal(d.edges[0].from.port, 'awaddr[19:0]');
    assert.equal(d.edges[0].to.port, 'awaddr[19:0]');
    assert.equal(d.edges[0].label, 'AXI4');
  });

  it('括号里的冒号不会被当成标签分隔符', () => {
    const text = `
kind: block
nodes: [{id: a}, {id: b}]
edges:
  - a.din[7:0] -> b.dout[7:0]
`;
    const { d, diagnostics } = one(text);
    assert.deepEqual(diagnostics.filter((x) => x.severity === 'error'), []);
    assert.equal(d.edges[0].from.port, 'din[7:0]');
    assert.equal(d.edges[0].label, undefined);
  });
});

describe('连线标签：不再吞掉信号名', () => {
  const mk = (edge: string) => `
kind: block
nodes: [{id: a}, {id: b}]
edges: ["${edge}"]
`;
  it('单个样式词仍按样式解释（向后兼容）', () => {
    const { d } = one(mk('a -> b : 总线'));
    assert.equal(d.edges[0].style, 'bus');
    assert.equal(d.edges[0].label, undefined);
  });

  it('多词标签里的 clk 当信号名保留', () => {
    const { d } = one(mk('a -> b : clk 32bit'));
    assert.equal(d.edges[0].label, 'clk 32bit');
    assert.equal(d.edges[0].style, 'wire');
  });

  it('支持 style:/route: 显式前缀', () => {
    const { d } = one(mk('a -> b : 数据 style:ctrl route:curve'));
    assert.equal(d.edges[0].label, '数据');
    assert.equal(d.edges[0].style, 'ctrl');
    assert.equal(d.edges[0].route, 'curve');
  });

  it('--> 不再被 -- 抢先匹配', () => {
    const { d } = one(mk('a --> b'));
    assert.equal(d.edges[0].arrow, 'end');
  });
});

describe('时序信号颜色', () => {
  it('合法色值保留到模型', () => {
    const { d, diagnostics } = one(`
kind: timing
signals:
  - {name: a, type: logic, values: "1010", color: "#e11"}
  - {name: b, type: logic, values: "1100", color: teal}
`);
    assert.equal(d.panels[0].rows[0].color, '#e11');
    assert.equal(d.panels[0].rows[1].color, 'teal');
    assert.deepEqual(diagnostics.filter((x) => x.severity === 'error'), []);
  });

  it('带引号/尖括号的注入式色值被丢弃并告警', () => {
    const { d, diagnostics } = one(`
kind: timing
signals:
  - {name: evil, type: logic, values: "10", color: "red\\" onload=\\"x"}
`);
    assert.equal(d.panels[0].rows[0].color, undefined);
    assert.equal(diagnostics.filter((x) => x.severity === 'warning').length, 1);
  });
});

describe('诊断行号：按出现位置而不是子串反查', () => {
  it('重复 id 报到第二处', () => {
    const text = `kind: block
nodes:
  - {id: a, label: A}
  - {id: a, label: A2}
`;
    const { diagnostics } = one(text);
    const dup = diagnostics.find((x) => x.message.includes('重复'));
    assert.ok(dup, '应报重复 id');
    assert.equal(dup.line, 4);
  });

  it('坏连线报到自己那一行', () => {
    const text = `kind: block
nodes: [{id: a}, {id: b}]
edges:
  - a -> b
  - a -> ghost
`;
    const { diagnostics } = one(text);
    const bad = diagnostics.find((x) => x.message.includes('ghost'));
    assert.ok(bad, '应报节点不存在');
    assert.equal(bad.line, 5, '应指向第二条连线');
  });

  it('行索引能区分同名值', () => {
    const idx = buildLineIndex('nodes:\n  - {id: x}\n  - {id: x}\n');
    assert.equal(idx.at('x'), 2);
    assert.equal(idx.at('x'), 3);
  });
});

describe('解析错误时给出可定位的诊断', () => {
  it('语法错误带行号', () => {
    const { diagnostics } = one('kind: block\nnodes: [{id: a}\nedges: [\n');
    const err = diagnostics.find((x) => x.severity === 'error');
    assert.ok(err, '应报语法错误');
    assert.ok(typeof err.line === 'number' && err.line > 0, `行号应有效，实际 ${err.line}`);
  });
});
