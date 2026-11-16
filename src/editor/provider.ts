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
    const post = (text: string) => {
      lastSent = text;
      void webview.postMessage({ type: 'update', text });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      const text = document.getText();
      if (text === lastSent) return;
      post(text);
    });

    const msgSub = webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg?.type) {
        case 'ready':
          post(document.getText());
          break;
        case 'edit': {
          const text = String(msg.text ?? '');
          if (text === document.getText()) {
            lastSent = text;
            return;
          }
          const edit = new vscode.WorkspaceEdit();
          const full = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
          edit.replace(document.uri, full, text);
          lastSent = text;
          await vscode.workspace.applyEdit(edit);
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
