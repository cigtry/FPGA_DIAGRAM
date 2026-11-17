import * as path from 'node:path';
import * as vscode from 'vscode';

export class FpgaEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'fpgaDiagram.editor';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      FpgaEditorProvider.viewType,
      new FpgaEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webview.html = this.html(webview);

    let lastSent = document.getText();
    /** 正在应用 webview 自己的编辑：这时 document 事件里拿到的文本变化不算外部改动 */
    let applyingFromWebview = false;
    /** 编辑器可能规范化行尾/末尾换行，回写后的文本未必等于 webview 发来的文本 */
    let pendingEchoId: string | undefined;
    const ack = (echoId?: string) => {
      if (echoId) void webview.postMessage({ type: 'ack', echoId });
    };
    const post = (text: string, echoId?: string) => {
      lastSent = text;
      void webview.postMessage(echoId ? { type: 'update', text, echoId } : { type: 'update', text });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (applyingFromWebview) return;
      const text = document.getText();
      if (text === lastSent) return;
      const echoId = pendingEchoId;
      pendingEchoId = undefined;
      post(text, echoId);
    });

    const msgSub = webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg?.type) {
        case 'ready':
          post(document.getText());
          break;
        case 'edit': {
          const text = String(msg.text ?? '');
          const echoId = typeof msg.echoId === 'string' ? msg.echoId : undefined;
          if (text === document.getText()) {
            lastSent = text;
            ack(echoId);
            return;
          }
          const edit = new vscode.WorkspaceEdit();
          const full = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
          edit.replace(document.uri, full, text);
          applyingFromWebview = true;
          pendingEchoId = echoId;
          try {
            await vscode.workspace.applyEdit(edit);
            // 以实际落进 document 的文本为准，避免行尾/末尾换行规范化触发一次假外部更新
            lastSent = document.getText();
          } finally {
            applyingFromWebview = false;
            ack(echoId);
          }
          break;
        }
        case 'export':
          await this.exportFile(document, msg);
          break;
        case 'openSource':
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
        case 'error':
          void vscode.window.showErrorMessage(String(msg.message ?? '未知错误'));
          break;
      }
    });

    panel.onDidDispose(() => {
      changeSub.dispose();
      msgSub.dispose();
    });
  }

  private async exportFile(document: vscode.TextDocument, msg: any) {
    const format = msg.format === 'png' ? 'png' : 'svg';
    const name = String(msg.name ?? `diagram.${format}`);
    const dir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
    const defaultUri = dir ? vscode.Uri.file(path.join(dir, name)) : vscode.Uri.file(name);

    const target = await vscode.window.showSaveDialog({
      defaultUri,
      saveLabel: '导出',
      filters: format === 'png' ? { 'PNG 图片': ['png'] } : { 'SVG 矢量图': ['svg'] },
    });
    if (!target) return;

    const data =
      format === 'png' ? Buffer.from(String(msg.base64 ?? ''), 'base64') : Buffer.from(String(msg.text ?? ''), 'utf8');
    await vscode.workspace.fs.writeFile(target, data);

    const open = '打开';
    const info = await vscode.window.showInformationMessage(`已导出：${path.basename(target.fsPath)}`, open);
    if (info === open) {
      if (format === 'png') await vscode.commands.executeCommand('vscode.open', target);
      else await vscode.commands.executeCommand('vscode.open', target);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'));
    const csp = `default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${css}" />
<title>FPGA 图表</title>
</head>
<body>
<div id="app">
  <div id="tabs"></div>
  <div id="toolbar"></div>
  <div id="main">
    <div id="palette"></div>
    <div id="stage">
      <svg id="grid" xmlns="http://www.w3.org/2000/svg"></svg>
      <svg id="canvas" xmlns="http://www.w3.org/2000/svg" tabindex="0"></svg>
      <div id="center-mark" title="画布中心：缩放与新增节点都以它为基准" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26">
          <path d="M13 1.5v8M13 16.5v8M1.5 13h8M16.5 13h8" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
          <circle cx="13" cy="13" r="2.6" fill="none" stroke="currentColor" stroke-width="1.2"/>
          <circle cx="13" cy="13" r="0.9" fill="currentColor"/>
        </svg>
      </div>
      <div id="diag-banner"></div>
      <div id="overlay"></div>
    </div>
    <div id="inspector"></div>
  </div>
  <div id="status"></div>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
