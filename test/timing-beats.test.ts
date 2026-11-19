import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseDiagram } from '../src/core/parse';
import { render, timingCaption, labelEvery, majorEvery } from '../src/core/render';
import { timingStats, timingSummary, tickOf } from '../src/core/model';
import { palette } from '../src/core/theme';

/**
 * 时序图里的「拍」必须等于一个时钟周期。
 * 旧实现把网格当拍数：100 MHz（10 ns/周期）+ tick 5 + 16 格会标「16 拍 · 80 ns · 5 ns/拍」，
 * 而实际只画出 8 个计数拍，标题和时钟、横轴互相矛盾。
 */
function doc(text: string) {
  return parseDiagram(text).diagram;
}

const TIMER = `kind: timing
title: 定时器计数
tick: 5
steps: 16
signals:
  - {name: clk, type: clock, freq: 100}
  - {name: tcr0, type: bus, values: "3 . 2 . 1 . 0 . 全1 . 3 . 2 . 1 ."}
`;

describe('格 / 拍：标题摘要和时钟、横轴自洽', () => {
  it('100 MHz + tick 5 + 16 格 = 8 拍 80 ns', () => {
    const d = doc(TIMER);
    const st = timingStats(d, d.panels[0]);
    assert.equal(st.tick, 5);
    assert.equal(st.beatNs, 10, '一拍 = 一个时钟周期 = 10 ns');
    assert.equal(st.spanNs, 80);
    assert.equal(st.beats, 8, '16 格 × 5 ns 只有 8 个时钟周期');
    assert.equal(st.cellsPerBeat, 2);
  });

  it('标题不再把格子数当拍数', () => {
    const d = doc(TIMER);
    const cap = timingCaption(d, d.panels[0]);
    assert.equal(cap, '8 拍 · 80 ns · 10 ns/拍 · 网格 5 ns');
    assert.ok(!cap.includes('16 拍'), '16 是格数，不是拍数');
    assert.ok(cap.includes('10 ns/拍'), '每拍时长必须等于时钟周期');
  });

  it('三个数满足 拍数 × 每拍 ns = 总时长 = 格数 × 网格', () => {
    const d = doc(TIMER);
    const st = timingStats(d, d.panels[0]);
    assert.equal(st.beats * st.beatNs, st.spanNs);
    assert.equal(st.spanNs, d.panels[0].steps * st.tick);
  });

  it('没有时钟的组：一拍 = 一格，措辞保持旧行为', () => {
    const d = doc(`kind: timing
tick: 5
steps: 16
signals:
  - {name: v, type: logic, values: "0 1 1 0"}
`);
    const cap = timingCaption(d, d.panels[0]);
    assert.equal(cap, '16 拍 · 80 ns · 5 ns/拍');
    assert.ok(!cap.includes('网格'), '格与拍相同时不重复报网格');
  });

  it('多时钟取组内最快时钟当拍长', () => {
    const d = doc(`kind: timing
tick: 5
steps: 20
signals:
  - {name: clk100, type: clock, freq: 100}
  - {name: clk148, type: clock, freq: 148.5}
  - {name: v, type: logic, values: "0 1"}
`);
    const st = timingStats(d, d.panels[0]);
    assert.ok(Math.abs(st.beatNs - 1000 / 148.5) < 1e-9);
    assert.ok(Math.abs(st.beats - (20 * 5) / (1000 / 148.5)) < 1e-9);
  });

  it('只写 period 的时钟：拍长 = period × 网格', () => {
    const d = doc(`kind: timing
tick: 5
steps: 16
signals:
  - {name: clk, type: clock, period: 4}
  - {name: v, type: logic, values: "0 1"}
`);
    const st = timingStats(d, d.panels[0]);
    assert.equal(st.beatNs, 20);
    assert.equal(st.beats, 4);
  });

  it('摘要用格而不是拍（validate 里那行）', () => {
    assert.equal(timingSummary(doc(TIMER)), '2 条信号 / 8 拍 · 80 ns');
    const noClock = doc(`kind: timing
tick: 10
steps: 12
signals:
  - {name: v, type: logic, values: "0 1"}
`);
    assert.equal(timingSummary(noClock), '1 条信号 / 12 格');
  });
});

describe('网格与刻度对齐时钟沿', () => {
  it('一个周期两格：主网格和刻度都每 2 格一条', () => {
    const d = doc(TIMER);
    assert.equal(majorEvery(d, d.panels[0]), 2);
    assert.equal(labelEvery(d, d.panels[0]), 2);
    const svg = render(d, { theme: palette('light') }).body;
    // 横轴标签落在 0/10/20…80，且不出现半拍位置
    const labels = [...svg.matchAll(/text-anchor="middle" font-family="[^"]+" font-size="9.5"[^>]*>([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(labels, ['0', '10', '20', '30', '40', '50', '60', '70', '80']);
  });

  it('没有时钟时退回每 4 格一条主网格', () => {
    const d = doc(`kind: timing
tick: 5
steps: 16
signals:
  - {name: v, type: logic, values: "0 1"}
`);
    assert.equal(majorEvery(d, d.panels[0]), 4);
    assert.equal(labelEvery(d, d.panels[0]), 4);
  });

  it('格数很多时标签不会挤成一团', () => {
    const d = doc(`kind: timing
tick: 5
steps: 64
signals:
  - {name: clk, type: clock, freq: 100}
  - {name: v, type: logic, values: "0 1"}
`);
    const every = labelEvery(d, d.panels[0]);
    assert.ok(every % majorEvery(d, d.panels[0]) === 0, '刻度必须是主网格的整数倍');
    assert.ok(d.panels[0].steps / every <= 12, `标签太多：每 ${every} 格一个`);
  });

  it('148.5 MHz 的周期不是整格时不硬凑主网格', () => {
    const d = doc(`kind: timing
tick: 5
steps: 20
signals:
  - {name: clk, type: clock, freq: 148.5}
  - {name: v, type: logic, values: "0 1"}
`);
    assert.equal(majorEvery(d, d.panels[0]), 4, '非整数格/周期退回 4 格，不假装对齐');
  });
});

describe('网格与时钟周期冲突时 validate 告警', () => {
  it('周期不是网格整数倍 → 提示建议 tick', () => {
    const r = parseDiagram(`kind: timing
tick: 3
steps: 16
signals:
  - {name: clk, type: clock, freq: 100}
  - {name: v, type: logic, values: "0 1"}
`);
    const msg = r.diagnostics.map((x) => x.message).join('\n');
    assert.match(msg, /不是网格 3 ns 的整数倍/);
    assert.match(msg, /建议 tick: 5/);
  });

  it('网格比周期还粗 → 提示时钟会被挤成锯齿', () => {
    const r = parseDiagram(`kind: timing
tick: 20
steps: 8
signals:
  - {name: clk, type: clock, freq: 100}
  - {name: v, type: logic, values: "0 1"}
`);
    const msg = r.diagnostics.map((x) => x.message).join('\n');
    assert.match(msg, /比时钟周期 10 ns 还粗/);
  });

  it('组时长不是整数拍 → 提示最后一拍会被画断', () => {
    const r = parseDiagram(`kind: timing
tick: 5
steps: 15
signals:
  - {name: clk, type: clock, freq: 100}
  - {name: v, type: logic, values: "0 1"}
`);
    const msg = r.diagnostics.map((x) => x.message).join('\n');
    assert.match(msg, /不到整数拍/);
    assert.match(msg, /steps 调到 16/);
  });

  it('没写 tick 时不替工具推导的网格报错', () => {
    const r = parseDiagram(`kind: timing
steps: 12
signals:
  - {name: clk, type: clock, freq: 148.5}
  - {name: v, type: logic, values: "0 1"}
`);
    const msg = r.diagnostics.map((x) => x.message).join('\n');
    assert.ok(!/不是网格|还粗|整数拍/.test(msg), `自动刻度不该报网格告警：${msg}`);
  });

  it('能整除的组不报时间告警', () => {
    const r = parseDiagram(TIMER);
    const msg = r.diagnostics.map((x) => x.message).join('\n');
    assert.ok(!/拍|网格/.test(msg), `不该有拍/网格告警：${msg}`);
  });
});

describe('窄组的标题摘要逐级缩短，不压住组名', () => {
  const narrow = (steps: number, title: string) => doc(`kind: timing
tick: 5
panels:
  - title: ${title}
    steps: ${steps}
    signals:
      - {name: clk, type: clock, freq: 100}
      - {name: v, type: logic, values: "0 1"}
`);

  it('摘要分三级：全量 / 去掉网格 / 只留拍数与时长', () => {
    const d = narrow(16, '写地址通道');
    const panel = d.panels[0];
    assert.equal(timingCaption(d, panel), '8 拍 · 80 ns · 10 ns/拍 · 网格 5 ns');
    assert.equal(timingCaption(d, panel, 'compact'), '8 拍 · 80 ns · 10 ns/拍');
    assert.equal(timingCaption(d, panel, 'min'), '8 拍 · 80 ns');
  });

  it('窄组不会把摘要甩到组名上', () => {
    const d = narrow(4, '写地址通道握手细节');
    const svg = render(d, { theme: palette('light') }).body;
    const cap = [...svg.matchAll(/font-size="10"[^>]*>([^<]*拍[^<]*)</g)].map((m) => m[1]);
    // 要么省略、要么只剩短摘要；不会出现最长的「网格」段
    for (const c of cap) assert.ok(!c.includes('网格'), `窄组不该带网格段：${c}`);
  });
});

describe('时序编辑面板与标题使用同一套数字', () => {
  it('tickOf 仍是网格分辨率，不受拍长影响', () => {
    assert.equal(tickOf(doc(TIMER)), 5);
  });
});
