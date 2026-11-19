import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { parseFile } from '../src/core/parse';
import { patchPositions, serializeFile } from '../src/core/serialize';

const SAMPLES_DIR = path.join(process.cwd(), 'samples');
const samples = fs.existsSync(SAMPLES_DIR)
  ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.fpgad'))
  : [];

describe('samples 回归', () => {
  it('至少有一个示例文件', () => {
    assert.ok(samples.length > 0, `未找到 samples：${SAMPLES_DIR}`);
  });

  for (const name of samples) {
    const text = fs.readFileSync(path.join(SAMPLES_DIR, name), 'utf8');

    it(`${name} 解析无 error`, () => {
      const { diagnostics } = parseFile(text);
      const errs = diagnostics.filter((d) => d.severity === 'error');
      assert.deepEqual(errs, [], `诊断：${JSON.stringify(errs)}`);
    });

    it(`${name} 序列化后能再解析回等价结构`, () => {
      const a = parseFile(text).file;
      const round = serializeFile(a);
      const b = parseFile(round).file;
      assert.equal(b.scenes.length, a.scenes.length, '视图数量应保持');
      assert.deepEqual(
        b.scenes.map((s) => s.kind),
        a.scenes.map((s) => s.kind),
        '视图类型应保持',
      );
      assert.deepEqual(b.scenes, a.scenes, '视图内容应等价');
    });
  }
});

describe('patchPositions：拖完节点只回写坐标', () => {
  it('保留行内注释，且不整文件重写', () => {
    const src = `kind: block
nodes:
  - {id: a, label: A} # 这是 A
  - {id: b, label: B}
`;
    const { file } = parseFile(src);
    const out = patchPositions(src, file.scenes[0]);
    assert.ok(out, '单视图文件应能就地回写');
    assert.ok(out!.includes('# 这是 A'), '注释必须保留');
  });

  it('结构对不上时宁可不动，也不毁掉原文', () => {
    const { file } = parseFile('kind: block\nnodes: [{id: a}, {id: b}]\n');
    const src = 'kind: block\n# 完全不同的一份文件\n';
    const out = patchPositions(src, file.scenes[0]);
    assert.ok(out === null || out === src, '结构不匹配时必须原样返回或 null，不能重写');
  });
});

describe('多视图不被压成单视图', () => {
  it('scenes 数量与 active 都能往返', () => {
    const text = `scenes:
  - kind: block
    title: 框图
    nodes: [{id: a}, {id: b}]
    edges: [a -> b]
  - kind: timing
    panels:
      - title: 时序
        steps: 8
        signals:
          - {name: clk, type: clock, freq: 100}
active: 1
`;
    const { file, diagnostics } = parseFile(text);
    assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), []);
    assert.equal(file.scenes.length, 2);
    assert.equal(file.active, 1);

    const back = parseFile(serializeFile(file)).file;
    assert.equal(back.scenes.length, 2);
    assert.equal(back.active, 1);
    assert.equal(back.scenes[1].kind, 'timing');
  });
});

describe('显式尺寸往返', () => {
  it('把节点缩到图形默认大小，保存后仍然是固定尺寸', () => {
    const { file } = parseFile(`kind: system_block
nodes:
  - {id: a, type: module, label: 一个很长的模块名字用于测试自适应宽度}
`);
    const nd = file.scenes[0].nodes[0];
    // 模拟用户拖边框：缩到默认尺寸，宽高都写成显式值
    nd.w = 130;
    nd.h = 60;
    nd.size = [130, 60];
    const text = serializeFile(file);
    assert.match(text, /size: \[130, 60\]/, '显式尺寸应写进文件');
    const back = parseFile(text).file.scenes[0].nodes[0];
    assert.deepEqual(back.size, [130, 60]);
    assert.deepEqual([back.w, back.h], [130, 60]);
  });

  it('没有显式尺寸的节点不会凭空写出 size', () => {
    const { file } = parseFile(`kind: system_block
nodes:
  - {id: a, type: module, label: A}
`);
    const text = serializeFile(file);
    assert.ok(!/size:/.test(text), '未设尺寸时不应写 size');
  });
});
