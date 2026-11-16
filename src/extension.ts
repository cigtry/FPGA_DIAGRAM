import * as os from 'node:os';
import * as vscode from 'vscode';
import { FpgaEditorProvider } from './editor/provider';
import { sample, sampleTitle } from './core/examples';
import { Kind } from './core/model';
import { parseFile } from './core/parse';
import { serializeFile } from './core/serialize';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(FpgaEditorProvider.register(context));

  const register = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('fpgaDiagram.new', async (uri?: vscode.Uri) => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '系统框图', description: '层次框 + 子模块 + 边界信号（硬件框图）', k: 'hier' },
        { label: '流程图', description: '模块按数据流从左到右串联，坐标自动排', k: 'block' },
        { label: '状态机', description: 'fsm · 状态 / 转移 / 条件', k: 'fsm' },
        { label: '时序波形', description: 'timing · 时钟 / 信号 / 总线', k: 'timing' },
        { label: '多视图示例', description: 'scenes · 框图 + 状态机 + 多组时序装在一个文件里', k: 'multi' },
      ],
      { title: '新建 FPGA 图表', placeHolder: '选择图表类型' },
    );
    if (!pick) return;
    await newDiagram((pick as any).k as string, uri);
  });

  register('fpgaDiagram.newBlock', (uri?: vscode.Uri) => newDiagram('hier', uri));
  register('fpgaDiagram.newFlow', (uri?: vscode.Uri) => newDiagram('block', uri));
  register('fpgaDiagram.newFsm', (uri?: vscode.Uri) => newDiagram('fsm', uri));
  register('fpgaDiagram.newTiming', (uri?: vscode.Uri) => newDiagram('timing', uri));

  register('fpgaDiagram.openDoc', async () => {
    const uri = vscode.Uri.joinPath(context.extensionUri, 'docs', 'DSL.md');
    try {
      await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
    } catch {
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  });

  register('fpgaDiagram.openSamples', async () => {
    const folder = await ensureSampleFolder();
    const target = vscode.Uri.joinPath(folder, 'block-sample.fpgad');
    await vscode.commands.executeCommand('vscode.openWith', target, FpgaEditorProvider.viewType);
  });

  registerLmTool(context);
}

async function newDiagram(template: string, hint?: vscode.Uri): Promise<void> {
  const dir = hint ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
  const defaultUri = vscode.Uri.joinPath(dir, `${sampleTitle(template)}.fpgad`);
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    saveLabel: '创建',
    filters: { 'FPGA 图表': ['fpgad'] },
  });
  if (!target) return;

  const uri = target.path.toLowerCase().endsWith('.fpgad') ? target : target.with({ path: target.path + '.fpgad' });
  await vscode.workspace.fs.writeFile(uri, Buffer.from(sample(template), 'utf8'));
  await vscode.commands.executeCommand('vscode.openWith', uri, FpgaEditorProvider.viewType);
}

async function ensureSampleFolder(): Promise<vscode.Uri> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.tmpdir());
  const folder = vscode.Uri.joinPath(root, 'fpga-samples');
  await vscode.workspace.fs.createDirectory(folder);
  const files: [string, string][] = [
    ['hier', 'soc-wdg.fpgad'],
    ['block', 'block-flow.fpgad'],
    ['fsm', 'fsm-sample.fpgad'],
    ['timing', 'timing-sample.fpgad'],
    ['multi', 'multi-view.fpgad'],
  ];
  for (const [tpl, name] of files) {
    const uri = vscode.Uri.joinPath(folder, name);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(sample(tpl), 'utf8'));
    }
  }
  void vscode.commands.executeCommand('revealInExplorer', folder);
  return folder;
}

/** 让 Chat（Copilot / Agent）能直接在对话里生成图表 —— 需要 VS Code 1.95+ */
function registerLmTool(context: vscode.ExtensionContext): void {
  const lm = (vscode as any).lm;
  const Result = (vscode as any).LanguageModelToolResult;
  const TextPart = (vscode as any).LanguageModelTextPart;
  if (!lm || typeof lm.registerTool !== 'function' || !Result || !TextPart) return;

  try {
    context.subscriptions.push(
      lm.registerTool('fpga_draw_diagram', {
        invoke: async (options: any) => {
          const spec = String(options?.input?.spec ?? '');
          const { file, diagnostics } = parseFile(spec);
          const diagram = file.scenes[file.active];
          const errors = diagnostics.filter((d) => d.severity === 'error');
          if (errors.length) {
            const list = errors.map((e) => `${e.line ? `第 ${e.line} 行：` : ''}${e.message}`).join('\n');
            return new Result([new TextPart(`生成失败，请修正 DSL 后重试：\n${list}`)]);
          }

          const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
          let name = String(options?.input?.filename ?? '').trim() || diagram.title || `${diagram.kind}-diagram`;
          name = name.replace(/[\\/:*?"<>|]+/g, '-');
          if (!name.toLowerCase().endsWith('.fpgad')) name += '.fpgad';

          let uri = vscode.Uri.joinPath(folder, name);
          try {
            await vscode.workspace.fs.stat(uri);
            uri = vscode.Uri.joinPath(folder, name.replace(/\.fpgad$/i, `-${Date.now().toString(36).slice(-4)}.fpgad`));
          } catch {
            /* 不存在则直接用 */
          }

          await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeFile(file), 'utf8'));
          await vscode.commands.executeCommand('vscode.openWith', uri, FpgaEditorProvider.viewType);

          const warn = diagnostics.filter((d) => d.severity === 'warning');
          const tail = warn.length ? `\n提示：${warn.map((w) => w.message).join('；')}` : '';
          return new Result([
            new TextPart(`已生成 ${diagram.kind} 图表：${uri.fsPath}${tail}`),
          ]);
        },
        prepareInvocation: async () => ({
          invocationMessage: '正在绘制 FPGA 图表',
        }),
      } as any),
    );
  } catch {
    /* 旧版本 VS Code 不支持，忽略 */
  }
}

export function deactivate(): void {}
