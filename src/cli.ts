#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseFile } from './core/parse';
import { render, svgDocument } from './core/render';
import { palette, ThemeName } from './core/theme';
import { serializeFile } from './core/serialize';
import { sample } from './core/examples';
import { KIND_LABEL, Kind, resolveKind, timingSummary } from './core/model';

interface Opts {
  out?: string;
  theme: ThemeName;
  scale: number;
  padding?: number;
  scene?: number;
  json: boolean;
}

function parseArgs(args: string[]): { cmd: string; file?: string; opts: Opts } {
  const opts: Opts = { theme: 'light', scale: 1, json: false };
  let cmd = '';
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--out') opts.out = args[++i];
    else if (a === '--theme') opts.theme = args[++i] === 'dark' ? 'dark' : 'light';
    else if (a === '--scale') opts.scale = Math.max(0.2, Math.min(8, Number(args[++i]) || 1));
    else if (a === '--padding') opts.padding = Number(args[++i]) || undefined;
    else if (a === '--scene') opts.scene = Math.max(0, (Number(args[++i]) || 1) - 1);
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('-')) continue;
    else if (!cmd) cmd = a;
    else if (!file) file = a;
  }
  return { cmd, file, opts };
}

function readInput(file?: string): { text: string; name: string } {
  if (!file || file === '-') return { text: readFileSync(0, 'utf8'), name: 'stdin' };
  const p = resolve(file);
  if (!existsSync(p)) {
    fail(`找不到文件：${p}`);
  }
  return { text: readFileSync(p, 'utf8'), name: basename(p) };
}

function fail(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function printDiagnostics(diags: { severity: string; message: string; line?: number }[]): number {
  let errors = 0;
  for (const d of diags) {
    const where = d.line ? `第 ${d.line} 行` : '';
    const tag = d.severity === 'error' ? '✖' : d.severity === 'warning' ? '⚠' : '·';
    if (d.severity === 'error') errors++;
    process.stderr.write(`${tag} ${where}${where ? '：' : ''}${d.message}\n`);
  }
  return errors;
}

function cmdRender(file: string | undefined, o: Opts) {
  const { text, name } = readInput(file);
  const { file: doc, diagnostics } = parseFile(text);
  const errors = printDiagnostics(diagnostics);
  if (errors) fail('渲染中止：请先修正上面的语法错误');
  const pick = Math.min(o.scene ?? doc.active, doc.scenes.length - 1);
  const diagram = doc.scenes[pick];
  if (doc.scenes.length > 1 && !o.json) {
    process.stderr.write(`· 多视图文件：渲染第 ${pick + 1}/${doc.scenes.length} 个视图（用 --scene N 指定）\n`);
  }

  const p = palette(o.theme);
  const res = render(diagram, { theme: p, padding: o.padding });
  const svg = svgDocument(res.body, res.width, res.height, p, diagram.title, o.scale);

  const out = o.out ?? (file && file !== '-' ? join(dirname(resolve(file)), basename(file, extname(file)) + '.svg') : 'out.svg');
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, svg, 'utf8');

  if (o.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, output: out, width: res.width, height: res.height, scene: pick, scenes: doc.scenes.length, kind: diagram.kind, nodes: diagram.nodes.length, edges: diagram.edges.length }, null, 2) + '\n',
    );
  } else {
    process.stdout.write(`✔ 已生成 ${out}  (${Math.round(res.width)}×${Math.round(res.height)}, ${diagram.nodes.length} 节点 / ${diagram.edges.length} 连线)\n`);
  }
  void name;
}

function cmdValidate(file: string | undefined, o: Opts) {
  const { text } = readInput(file);
  const { file: doc, diagnostics } = parseFile(text);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const detailOf = (d: (typeof doc.scenes)[number]) =>
    d.kind === 'timing' ? timingSummary(d) : `${d.nodes.length} 节点 / ${d.edges.length} 连线`;
  if (o.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: errors === 0,
          diagnostics,
          scenes: doc.scenes.map((s, i) => ({ index: i + 1, kind: s.kind, title: s.title, detail: detailOf(s) })),
          active: doc.active + 1,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    printDiagnostics(diagnostics);
    const lines = doc.scenes.map((s, i) => `  ${i === doc.active ? '*' : ' '} ${i + 1}. ${s.title || KIND_LABEL[s.kind]}（${KIND_LABEL[s.kind]}）：${detailOf(s)}`);
    const head = doc.scenes.length > 1 ? `${doc.scenes.length} 个视图` : detailOf(doc.scenes[doc.active]);
    if (errors) process.stderr.write(`✖ 校验失败：${head}\n${lines.join('\n')}\n`);
    else process.stdout.write(`✔ 校验通过：${head}\n${doc.scenes.length > 1 ? lines.join('\n') + '\n' : ''}`);
  }
  if (errors) process.exit(1);
}

function cmdFmt(file: string | undefined, o: Opts) {
  const { text } = readInput(file);
  const { file: doc, diagnostics } = parseFile(text);
  if (printDiagnostics(diagnostics)) fail('格式化中止');
  const out = serializeFile(doc);
  if (o.out) writeFileSync(o.out, out, 'utf8');
  else process.stdout.write(out);
}

function cmdNew(kind: string | undefined, o: Opts) {
  const requested = String(kind ?? '').toLowerCase();
  const k: Kind = resolveKind(requested) ?? 'block';
  const text = sample(requested === 'multi' ? 'multi' : requested === 'hier' ? 'hier' : k);
  if (o.out) writeFileSync(o.out, text, 'utf8');
  else process.stdout.write(text);
}

function help() {
  process.stdout.write(
    [
      'fpga-diagram —— FPGA 框图 / 状态机 / 时序波形，文本即图形',
      '',
      '用法：',
      '  fpga-diagram render <file.fpgad> [-o out.svg] [--theme dark|light] [--scale 2]',
      '  fpga-diagram validate <file.fpgad> [--json]',
      '  fpga-diagram fmt <file.fpgad> [-o out.fpgad]',
      '  fpga-diagram new system_block|schematic|datapath|block|hier|fsm|timing|multi [-o out.fpgad]',
      '  fpga-diagram mcp                 # 以 MCP server 方式启动（stdio）',
      '',
      '提示：文件参数写 - 表示从 stdin 读入。',
    ].join('\n') + '\n',
  );
}

async function main() {
  const args = process.argv.slice(2);
  const { cmd, file, opts } = parseArgs(args);
  switch (cmd) {
    case 'render':
    case 'r':
      return cmdRender(file, opts);
    case 'validate':
    case 'check':
      return cmdValidate(file, opts);
    case 'fmt':
    case 'format':
      return cmdFmt(file, opts);
    case 'new':
      return cmdNew(file, opts);
    case 'mcp': {
      const { startMcp } = await import('./mcp');
      return startMcp();
    }
    case 'help':
    case '--help':
    case '-h':
    case '':
      return help();
    default:
      help();
      fail(`未知命令：${cmd}`);
  }
}

main().catch((e) => fail(String(e?.stack ?? e)));
