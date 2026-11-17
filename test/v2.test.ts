import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseFile, parseDiagram } from '../src/core/parse';
import { serializeFile } from '../src/core/serialize';
import { isV2 } from '../src/core/model';

/** v2 完整文档：version/meta/options + scenes + waypoints/style/width/order/children */
const V2_DOC = `version: '2.0'
meta:
  title: 视频处理子系统
  author: 张三
options:
  grid: true
  gridSize: 20
  snapToGrid: true
scenes:
  - id: arch
    kind: system_block
    title: 系统架构
    layout:
      strategy: auto
      direction: LR
      nodeSpacing: 80
    nodes:
      - {id: camera, type: io, label: Camera, ports: "r: pixel[7:0]<"}
      - {id: scaler, type: module, label: Scaler, style: {fill: "#eef", dashed: true}}
    edges:
      - {from: camera, to: scaler, waypoints: [[100, 50], [140, 50]], visual: {stroke: "#c33", dashed: true}}
  - id: wave
    kind: timing
    title: 写通道
    tick: 5
    panels:
      - title: 写地址
        steps: 8
        signals:
          - {name: clk, type: clock, freq: 100}
          - {name: awaddr, type: bus, width: "[19:0]", order: 1, values: "A0 A1 z"}
          - {name: ctrl, type: group, children: [{name: wen, type: logic, values: "0101"}, {name: wdata, type: bus, width: 32, values: "1 2 3 4"}]}
`;

describe('v2 文档头', () => {
  it('解析 version / meta / options', () => {
    const { file, diagnostics } = parseFile(V2_DOC);
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === 'error'),
      [],
    );
    assert.equal(file.version, '2.0');
    assert.equal(isV2(file), true);
    assert.equal(file.meta?.title, '视频处理子系统');
    assert.equal(file.meta?.author, '张三');
    assert.equal(file.options?.grid, true);
    assert.equal(file.options?.gridSize, 20);
    assert.equal(file.options?.snapToGrid, true);
  });

  it('scene id / title / layout 对象都读到', () => {
    const { file } = parseFile(V2_DOC);
    const arch = file.scenes[0];
    assert.equal(arch.id, 'arch');
    assert.equal(arch.title, '系统架构');
    assert.equal(arch.options.layout, 'auto');
    assert.equal(arch.options.direction, 'LR');
    assert.equal(arch.options.nodeSpacing, 80);
  });

  it('旧文件没有 version 时 isV2 为假', () => {
    const { file } = parseFile('kind: block\nnodes: [{id: a}]\n');
    assert.equal(file.version, undefined);
    assert.equal(isV2(file), false);
  });
});

describe('v2 节点与端口', () => {
  it('端口位宽从 [7:0] 自动提取，方向后缀仍生效', () => {
    const { file } = parseFile(V2_DOC);
    const camera = file.scenes[0].nodes.find((n) => n.id === 'camera')!;
    assert.equal(camera.ports[0].name, 'pixel');
    assert.equal(camera.ports[0].width, '7:0');
    assert.equal(camera.ports[0].dir, 'in');
  });

  it('节点 style 对象解析', () => {
    const { file } = parseFile(V2_DOC);
    const scaler = file.scenes[0].nodes.find((n) => n.id === 'scaler')!;
    assert.equal(scaler.style?.fill, '#eef');
    assert.equal(scaler.style?.dashed, true);
  });

  it('连线 waypoints 与 visual 解析', () => {
    const { file } = parseFile(V2_DOC);
    const e = file.scenes[0].edges[0];
    assert.deepEqual(e.waypoints, [
      [100, 50],
      [140, 50],
    ]);
    assert.equal(e.visual?.stroke, '#c33');
    assert.equal(e.visual?.dashed, true);
  });
});

describe('v2 时序信号', () => {
  it('bus width / order 解析', () => {
    const { file } = parseFile(V2_DOC);
    const rows = file.scenes[1].panels[0].rows;
    const addr = rows.find((r) => r.name === 'awaddr')!;
    assert.equal(addr.width, '[19:0]');
    assert.equal(addr.order, 1);
  });

  it('group 子信号递归解析', () => {
    const { file } = parseFile(V2_DOC);
    const rows = file.scenes[1].panels[0].rows;
    const ctrl = rows.find((r) => r.name === 'ctrl')!;
    assert.equal(ctrl.type, 'group');
    assert.equal(ctrl.children?.length, 2);
    assert.equal(ctrl.children?.[0].name, 'wen');
    assert.equal(ctrl.children?.[1].width, '32');
  });
});

describe('v2 序列化往返', () => {
  it('v2 文档序列化后仍解析出等价结构', () => {
    const a = parseFile(V2_DOC).file;
    const text = serializeFile(a);
    assert.ok(text.includes("version: '2.0'"));
    const b = parseFile(text).file;
    assert.equal(b.version, '2.0');
    assert.equal(b.meta?.title, '视频处理子系统');
    assert.equal(b.options?.grid, true);
    assert.equal(b.scenes.length, 2);
    assert.equal(b.scenes[0].id, 'arch');
    const e = b.scenes[0].edges[0];
    assert.deepEqual(e.waypoints, [
      [100, 50],
      [140, 50],
    ]);
    const addr = b.scenes[1].panels[0].rows.find((r) => r.name === 'awaddr')!;
    assert.equal(addr.width, '[19:0]');
    const ctrl = b.scenes[1].panels[0].rows.find((r) => r.name === 'ctrl')!;
    assert.equal(ctrl.children?.length, 2);
  });

  it('v1 单图序列化不写 version 头（不升级旧图）', () => {
    const a = parseFile('kind: block\nnodes: [{id: a, label: A}]\nedges: []\n').file;
    const text = serializeFile(a);
    assert.ok(!text.includes('version:'));
    assert.ok(!text.includes('scenes:'));
  });
});

describe('datapath 类型', () => {
  it('datapath 作为独立 kind，组件表与 schematic 一致', () => {
    const { file, diagnostics } = parseFile('diagram_type: datapath\nnodes: [{id: a, type: adder}]\n');
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === 'error'),
      [],
    );
    assert.equal(file.scenes[0].kind, 'datapath');
  });
});
