import * as esbuild from 'esbuild';
import { mkdirSync, existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');
const test = process.argv.includes('--test');

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  minify: prod,
  sourcemap: !prod,
  logLevel: 'info',
  target: ['es2020'],
};

// 测试：打成一个 CJS 包交给 node --test，无需引入 ts-jest 之类的运行时依赖
if (test) {
  mkdirSync('out/test', { recursive: true });
  const { readdirSync } = await import('node:fs');
  const entries = readdirSync('test')
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `test/${f}`);
  await esbuild.build({
    ...common,
    minify: false,
    sourcemap: false,
    entryPoints: entries,
    outdir: 'out/test',
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
  });
  console.log(`test build done: ${entries.length} 个用例文件`);
  process.exit(0);
}

mkdirSync('out', { recursive: true });

const targets = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  // MCP server 由 `cli.js mcp` 启动（src/cli.ts 动态 import startMcp），
  // 单独再打一份 out/mcp.js 是死代码：没有 main 守卫，跑起来什么都不做
  { ...common, entryPoints: ['src/cli.ts'], outfile: 'out/cli.js', platform: 'node', format: 'cjs' },
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'media/webview.js', platform: 'browser', format: 'iife' },
];

// 静态资源是运行必需项，缺了直接失败，别留一堆探测不到东西的空循环
const REQUIRED_ASSETS = ['media/editor.css'];

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context(t);
    await ctx.watch();
  }
  console.log('watching...');
} else {
  for (const f of REQUIRED_ASSETS) {
    if (!existsSync(f)) {
      console.error(`[esbuild] 缺少必需静态资源：${f}`);
      process.exit(1);
    }
  }
  await Promise.all(targets.map((t) => esbuild.build(t)));
  console.log('build done');
}
