import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseFile } from '../src/core/parse';
import { serializeFile } from '../src/core/serialize';
import { layout } from '../src/core/layout';
import { render, resolveEdge, panelHeight } from '../src/core/render';
import { palette } from '../src/core/theme';

function diagram(text: string) {
  return parseFile(text).file.scenes[0];
}

function svg(d: ReturnType<typeof diagram>) {
  return render(d, { theme: palette('light') }).body;
}

describe('时序时间基准：真实 ns，不再按拍取整', () => {
  const clocks = `kind: timing
signals:
  - {name: clk100, type: clock, freq: 100}
  - {name: clk148, type: clock, freq: 148.5}
  - {name: clk27, type: clock, freq: 27}
`;

  it('频率换算保留真实周期（100 / 148.5 / 27 MHz）', () => {
    const d = diagram(clocks);
    const rows = d.panels[0].rows;
    assert.equal(rows[0].periodNs, 10);
    assert.ok(Math.abs((rows[1].periodNs as number) - 1000 / 148.5) < 1e-9, '148.5 MHz 不应被拉成 100 或 125');
    assert.ok(Math.abs((rows[2].periodNs as number) - 1000 / 27) < 1e-9);
  });

  it('推导出的 tick 只进内存，不写回文件', () => {
    const file = parseFile(clocks).file;
    assert.equal(file.scenes[0].tick, undefined, 'tick 是推导值，不能当成用户输入');
    assert.ok(file.scenes[0].tickAuto && file.scenes[0].tickAuto > 0);
    const out = serializeFile(file);
    assert.ok(!/^tick:/m.test(out), `文件里不应出现推导 tick：\n${out}`);
  });

  it('画出来的沿间距按频率成正比（1.485 倍）', () => {
    const d = diagram(clocks);
    const body = svg(d);
    const paths = [...body.matchAll(/<path d="([^"]+)"[^>]*stroke-width="1\.7"[^>]*>/g)].map((m) => m[1]);
    assert.equal(paths.length, 3, '三条时钟各一条路径');
    const half = (p: string): number => {
      const xs = [...p.matchAll(/H([\d.]+) V/g)].map((m) => Number(m[1]));
      assert.ok(xs.length >= 2, `沿太少：${p}`);
      return xs[1] - xs[0];
    };
    const h100 = half(paths[0]);
    const h148 = half(paths[1]);
    // 100 MHz 的半周期应比 148.5 MHz 宽 1.485 倍；旧实现会反过来
    assert.ok(Math.abs(h100 / h148 - 1.485) < 0.01, `间距比 ${h100 / h148}，应约 1.485`);
  });
});

describe('连线端点按端口声明锚定', () => {
  const text = `kind: system_block
nodes:
  - {id: dst, type: module, label: 目标, pos: [40, 60], ports: "r:sin"}
  - {id: src, type: module, label: 源, pos: [420, 60], ports: "r:dout | l:din[19:0]"}
edges:
  - src.dout -> dst.sin
`;

  it('dout 声明在右边，就从右边出（不按两节点相对位置猜）', () => {
    const d = diagram(text);
    layout(d);
    const src = d.nodes.find((n) => n.id === 'src')!;
    const pair = resolveEdge(d, d.edges[0])!;
    assert.equal(pair.a.side, 'r');
    assert.equal(pair.a.x, src.x + src.w);
  });

  it('端口不存在时报错并给出可用端口', () => {
    const bad = `${text}  - dst.sin -> src.ghost\n`;
    const { diagnostics } = parseFile(bad);
    const err = diagnostics.find((x) => x.severity === 'error' && x.message.includes('ghost'));
    assert.ok(err, '应报端口不存在');
    assert.match(err!.message, /dout/);
  });

  it('位宽画在端口名旁边', () => {
    const d = diagram(`${text}  - src.din[19:0] -> dst.sin\n`);
    const body = svg(d);
    assert.match(body, /din\[19:0\]/);
  });
});

describe('时序分组子信号真的会被画出来', () => {
  const text = `kind: timing
steps: 12
signals:
  - name: 写通道
    type: group
    children:
      - {name: wen, type: logic, values: "011100000000"}
      - {name: wdata, type: bus, width: "31:0", values: "A0 . . B1 . . . . . ."}
  - {name: aclk, type: clock, freq: 100}
`;

  it('子信号出现在 SVG 里，且面板高度把子行算进去', () => {
    const d = diagram(text);
    const rows = d.panels[0].rows;
    assert.equal(rows[0].children?.length, 2);
    const body = svg(d);
    assert.match(body, />wen</);
    assert.match(body, /wdata\[31:0\]/);
    // 1 行分组标题 + 2 行子信号 + 1 行时钟 = 4 行
    const baseline = panelHeight({ steps: 12, rows: [rows[1]] });
    assert.equal(panelHeight(d.panels[0]), baseline + 3 * 34);
  });
});

describe('未知字段与重复名不再静默', () => {
  it('signals 写成 signal 会给出最近键名提示', () => {
    const { diagnostics } = parseFile(`kind: timing
signal:
  - {name: a, type: logic, values: "10"}
`);
    const warn = diagnostics.find((d) => d.message.includes('"signal"'));
    assert.ok(warn, '应提示未知字段');
    assert.match(warn!.message, /signals/);
  });

  it('节点字段写错也会提示', () => {
    const { diagnostics } = parseFile(`kind: system_block
nodes:
  - {id: a, lable: A}
`);
    assert.ok(diagnostics.some((d) => d.message.includes('lable') && d.message.includes('label')));
  });

  it('重复端口名不再被无声丢弃', () => {
    const { diagnostics } = parseFile(`kind: system_block
nodes:
  - {id: a, label: A, ports: "l:clk | r:clk"}
`);
    assert.ok(diagnostics.some((d) => d.message.includes('端口 "clk" 重复')));
  });
});
