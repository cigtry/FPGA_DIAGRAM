/**
 * 纯函数文本度量：Node 与浏览器结果完全一致，保证布局可复现。
 * 不做真实字体测量，用字符类别估算字宽（CJK 1em，拉丁 0.55em）。
 */
const CJK = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef\u3000-\u303f]/;

export function charWidth(ch: string, size: number): number {
  if (ch === ' ') return size * 0.3;
  if (ch === '\t') return size * 0.6;
  if (CJK.test(ch)) return size * 1.0;
  if (/[iljIJ.,:;'`|!\[\](){}]/.test(ch)) return size * 0.3;
  if (/[mwMW@%]/.test(ch)) return size * 0.86;
  if (/[A-Z]/.test(ch)) return size * 0.66;
  if (/[0-9]/.test(ch)) return size * 0.57;
  return size * 0.55;
}

export function measure(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, size);
  return w;
}

/** 按宽度折行，中文按字断，英文优先在空格/下划线处断 */
export function wrap(text: string, maxWidth: number, size: number): string[] {
  const out: string[] = [];
  if (!text) return out;
  for (const para of String(text).split('\n')) {
    if (!para) {
      out.push('');
      continue;
    }
    if (measure(para, size) <= maxWidth) {
      out.push(para);
      continue;
    }
    let line = '';
    let lastBreak = -1;
    for (const ch of para) {
      if (measure(line + ch, size) > maxWidth && line) {
        if (lastBreak > 0 && CJK.test(line[line.length - 1]) === false) {
          out.push(line.slice(0, lastBreak));
          line = line.slice(lastBreak).trimStart();
        } else {
          out.push(line);
          line = '';
        }
        lastBreak = -1;
      }
      line += ch;
      if (/[\s_\-/]/.test(ch)) lastBreak = line.length;
    }
    if (line) out.push(line);
  }
  return out;
}

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const FONT = `-apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif`;
export const MONO = `'Cascadia Mono', Consolas, 'Courier New', monospace`;

/** 数字保留 1 位小数，减小 SVG 体积 */
export function n(v: number): string {
  const r = Math.round(v * 10) / 10;
  return String(r);
}
