import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

mkdirSync('out', { recursive: true });

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  minify: prod,
  sourcemap: !prod,
  logLevel: 'info',
  target: ['es2020'],
};

const targets = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  { ...common, entryPoints: ['src/cli.ts'], outfile: 'out/cli.js', platform: 'node', format: 'cjs' },
  { ...common, entryPoints: ['src/mcp.ts'], outfile: 'out/mcp.js', platform: 'node', format: 'cjs' },
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'media/webview.js', platform: 'browser', format: 'iife' },
];

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context(t);
    await ctx.watch();
  }
  console.log('watching...');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
  for (const f of ['media/editor.css', 'media/editor.html']) {
    if (existsSync(f)) void f;
  }
  console.log('build done');
}
