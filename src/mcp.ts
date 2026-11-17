import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFile } from './core/parse';
import { render, svgDocument } from './core/render';
import { palette, ThemeName } from './core/theme';
import { serializeFile } from './core/serialize';
import { sample } from './core/examples';
import { timingSummary } from './core/model';
// 版本号只有 package.json 一个出处，避免服务端自报版本和插件版本各说各话
import pkg from '../package.json';

type Json = Record<string, any>;

const PKG_VERSION = (pkg as { version: string }).version;
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26'];

const TOOLS = [
  {
    name: 'fpga_diagram_render',
    description:
      '把 FPGA Diagram DSL（YAML 子集）渲染为 SVG 或 .fpgad 文件。新建图请用 diagram_type: system_block（顶层系统框图）或 kind: fsm / kind: timing；旧文件中的 schematic、datapath、block 仍可解析，但不再提供新建入口。文件头写 version: \'2.0\' 启用 v2 文档模型（meta/options、节点 style、连线 waypoints、端口 width）。system_block 里写加法器、寄存器、时钟原语会收到规范提示。坐标自动布局，不需要手写位置。',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: '完整的 DSL 文本，第一行形如 diagram_type: system_block 或 kind: fsm' },
        output: { type: 'string', description: '输出文件路径（.svg 或 .fpgad）。省略则写入系统临时目录' },
        format: { type: 'string', enum: ['svg', 'fpgad'], description: '输出格式，默认由 output 扩展名推断，否则 svg' },
        theme: { type: 'string', enum: ['light', 'dark'], description: 'SVG 配色，默认 light' },
        scale: { type: 'number', description: 'SVG 缩放倍数，默认 1' },
      },
      required: ['spec'],
    },
  },
  {
    name: 'fpga_diagram_validate',
    description: '校验 FPGA Diagram DSL 语法与引用关系，返回带行号的错误/警告列表，便于自我修正。',
    inputSchema: {
      type: 'object',
      properties: { spec: { type: 'string', description: '待校验的 DSL 文本' } },
      required: ['spec'],
    },
  },
  {
    name: 'fpga_diagram_example',
    description: '返回某种图表的完整 DSL 示例，可作为生成时的格式模板。',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['system_block', 'datapath', 'fsm', 'timing', 'multi'] } },
      required: ['kind'],
    },
  },
];

function send(msg: Json) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id: Json, result: Json) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: Json, code: number, message: string) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function text(t: string, isError = false): Json {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
}

function callTool(name: string, args: Json): Json {
  if (name === 'fpga_diagram_example') {
    const kind = String(args?.kind ?? '').toLowerCase();
    return text(sample(kind || 'system_block'));
  }

  const spec = String(args?.spec ?? '');
  if (!spec.trim()) return text('缺少 spec 参数（应为完整的 DSL 文本）', true);
  const { file, diagnostics } = parseFile(spec);
  const diagram = file.scenes[file.active];
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnText = diagnostics
    .map((d) => `${d.severity === 'error' ? '错误' : '警告'}${d.line ? ` 第${d.line}行` : ''}：${d.message}`)
    .join('\n');

  if (name === 'fpga_diagram_validate') {
    return text(
      (errors.length ? `✖ 校验失败\n${warnText}` : `✔ 校验通过${warnText ? '\n' + warnText : ''}`) +
        `\n\n${file.scenes.length > 1 ? `共 ${file.scenes.length} 个视图，当前第 ${file.active + 1} 个：` : ''}` +
        `类型：${diagram.kind}；` +
        (diagram.kind === 'timing'
          ? timingSummary(diagram)
          : `节点 ${diagram.nodes.length} 个，连线 ${diagram.edges.length} 条`),
      errors.length > 0,
    );
  }

  if (name === 'fpga_diagram_render') {
    if (errors.length) return text(`渲染中止，请先修正：\n${warnText}`, true);
    const fmt = args?.format ?? (String(args?.output ?? '').endsWith('.fpgad') ? 'fpgad' : 'svg');
    const theme: ThemeName = args?.theme === 'dark' ? 'dark' : 'light';
    const scale = Math.max(0.2, Math.min(8, Number(args?.scale ?? 1) || 1));

    let body: string;
    let width = 0;
    let height = 0;
    if (fmt === 'fpgad') {
      body = serializeFile(file);
    } else {
      const p = palette(theme);
      const res = render(diagram, { theme: p });
      width = Math.ceil(res.width * scale);
      height = Math.ceil(res.height * scale);
      body = svgDocument(res.body, res.width, res.height, p, diagram.title, scale);
    }

    const ext = fmt === 'fpgad' ? '.fpgad' : '.svg';
    const dir = join(tmpdir(), 'fpga-diagram');
    mkdirSync(dir, { recursive: true });
    const slug = (diagram.title || diagram.kind).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    const out = String(args?.output ?? join(dir, `${slug || 'diagram'}${ext}`));
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, body, 'utf8');

    return text(
      `✔ 已生成：${out}\n类型：${diagram.kind}` +
        (file.scenes.length > 1 ? `（多视图 ${file.scenes.length} 个，默认打开第 ${file.active + 1} 个）` : '') +
        (diagram.kind === 'timing'
          ? `，${timingSummary(diagram)}`
          : `，节点 ${diagram.nodes.length} 个 / 连线 ${diagram.edges.length} 条`) +
        (fmt === 'svg' ? `，尺寸 ${width}×${height}` : '') +
        (warnText ? `\n${warnText}` : ''),
    );
  }

  return text(`未知工具：${name}`, true);
}

function handle(msg: Json) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      if (isNotification) return;
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(String(params?.protocolVersion))
          ? params.protocolVersion
          : SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fpga-diagram', version: PKG_VERSION },
        instructions:
          'FPGA 图表工具。用 fpga_diagram_example 取模板，用 fpga_diagram_validate 自检，用 fpga_diagram_render 产出 SVG 或 .fpgad。DSL 为 YAML 子集，只需描述节点与连线，坐标自动布局。',
      });
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      if (isNotification) return;
      return reply(id, {});
    case 'tools/list':
      if (isNotification) return;
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      if (isNotification) return;
      const name = String(params?.name ?? '');
      try {
        return reply(id, callTool(name, (params?.arguments ?? {}) as Json));
      } catch (e: any) {
        return replyError(id, -32603, String(e?.message ?? e));
      }
    }
    case 'resources/list':
      if (isNotification) return;
      return reply(id, { resources: [] });
    case 'prompts/list':
      if (isNotification) return;
      return reply(id, { prompts: [] });
    default:
      if (isNotification) return;
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

export function startMcp() {
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* 忽略坏行 */
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
