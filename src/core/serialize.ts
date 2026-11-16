import { Diagram, DiagramEdge, DiagramNode, SceneFile, shapeOf } from './model';

function q(s: string): string {
  if (s === '') return '""';
  const need =
    /^\s|\s$/.test(s) ||
    /[:#{}[\],&*?|>'"%@`]/.test(s) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /^[-!]/.test(s) ||
    /[\n\t]/.test(s);
  if (!need) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function portsSpec(nd: DiagramNode): string | undefined {
  if (!nd.ports.length) return undefined;
  const groups: string[] = [];
  for (const side of ['l', 'r', 't', 'b'] as const) {
    const list = nd.ports
      .filter((p) => p.side === side)
      .map((p) => (p.dir === 'both' ? `${p.name}<>` : p.dir === 'out' ? `${p.name}>` : p.dir === 'in' ? `${p.name}<` : p.name));
    if (list.length) groups.push(`${side}:${list.join(',')}`);
  }
  return groups.join(' | ');
}

/** 连线的端点：`A.port` 不够，显式指定了边（side）时写成 {node, side} */
function endpoint(node: string, port?: string, side?: string): string {
  if (port) return `${node}.${port}`;
  if (side) return `{node: ${q(node)}, side: ${side}}`;
  return node;
}

function edgeLine(d: Diagram, e: DiagramEdge): string {
  const from = endpoint(e.from.node, e.from.port, e.from.side);
  const to = endpoint(e.to.node, e.to.port, e.to.side);
  const arrow = e.arrow === 'both' ? '<->' : e.arrow === 'none' ? '--' : '->';
  const tailBits: string[] = [];
  if (e.label) tailBits.push(e.label);
  if (e.action) tailBits.push(`action: ${q(e.action)}`);
  if (e.style !== 'wire') tailBits.push(e.style);
  if (e.route !== 'orth') tailBits.push(e.route);
  const tail = tailBits.length ? ` : ${tailBits.join(' ')}` : '';
  // 端点写成映射时不能用箭头简写，退回字段写法
  if (from.startsWith('{') || to.startsWith('{')) {
    const obj = [
      `from: ${from}`,
      `to: ${to}`,
      e.arrow !== 'end' ? `arrow: ${e.arrow}` : '',
      e.label ? `label: ${q(e.label)}` : '',
      e.action ? `action: ${q(e.action)}` : '',
      e.style !== 'wire' ? `style: ${e.style}` : '',
      e.route !== 'orth' ? `route: ${e.route}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `  - {${obj}}`;
  }
  void d;
  return `  - ${from} ${arrow} ${to}${tail}`;
}

/** 单张图的 YAML 主体（不含注释头） */
function sceneLines(d: Diagram): string[] {
  if (d.kind === 'timing') return timingLines(d);
  const out: string[] = [];
  out.push(`kind: ${d.kind}`);
  if (d.title) out.push(`title: ${q(d.title)}`);
  const optLines: string[] = [];
  if (d.options.direction !== 'LR') optLines.push(`  direction: ${d.options.direction}`);
  if (d.options.layout !== 'auto') optLines.push(`  layout: ${d.options.layout}`);
  if (optLines.length) out.push('options:\n' + optLines.join('\n'));
  out.push('');

  const nodeKey = d.kind === 'fsm' ? 'states' : 'nodes';
  out.push(`${nodeKey}:`);
  if (!d.nodes.length) out.push('  []');
  for (const nd of d.nodes) {
    const fields: string[] = [`id: ${q(nd.id)}`];
    const shape = shapeOf(nd.type, d.kind);
    fields.push(`type: ${nd.type}`);
    if (nd.label && nd.label !== nd.id) fields.push(`label: ${q(nd.label)}`);
    if (nd.sub) fields.push(`sub: ${q(nd.sub)}`);
    const ps = portsSpec(nd);
    if (ps) fields.push(`ports: ${q(ps)}`);
    if ((nd.type === 'group' || nd.type === 'frame') && nd.children?.length) {
      fields.push(`children: [${nd.children.map((c) => q(c)).join(', ')}]`);
    }
    if (nd.type === 'frame') {
      if (nd.dash) fields.push('style: dashed');
      if (nd.titlePos === 'br') fields.push('titlePos: br');
    }
    if (nd.size && (nd.size[0] !== shape.w || nd.size[1] !== shape.h)) fields.push(`size: [${nd.size[0]}, ${nd.size[1]}]`);
    if (nd.pos) fields.push(`pos: [${Math.round(nd.pos[0])}, ${Math.round(nd.pos[1])}]`);
    out.push(`  - {${fields.join(', ')}}`);
  }
  out.push('');

  const edgeKey = d.kind === 'fsm' ? 'transitions' : 'edges';
  out.push(`${edgeKey}:`);
  if (!d.edges.length) out.push('  []');
  for (const e of d.edges) out.push(edgeLine(d, e));
  out.push('');
  return out;
}

function signalLine(r: { name: string; type: string; period?: number; freq?: number; duty?: number; phase?: number; values: string[] }): string {
  const fields: string[] = [`name: ${q(r.name)}`, `type: ${r.type}`];
  if (r.freq) fields.push(`freq: ${r.freq}`);
  else if (r.type === 'clock') fields.push(`period: ${r.period ?? 2}`);
  if (r.type === 'clock') {
    if ((r.duty ?? 0.5) !== 0.5) fields.push(`duty: ${r.duty}`);
    if (r.phase) fields.push(`phase: ${r.phase}`);
  } else if (r.type === 'logic' || r.type === 'bus') {
    const compact = r.values.map((v) => (v === '' ? '.' : v)).join(' ');
    fields.push(`values: ${q(compact)}`);
  }
  return `  - {${fields.join(', ')}}`;
}

function timingLines(d: Diagram): string[] {
  const out: string[] = [];
  out.push('kind: timing');
  if (d.title) out.push(`title: ${q(d.title)}`);
  if (d.tick && d.tick !== 10) out.push(`tick: ${d.tick}`);

  const multi = d.panels.length > 1 || !!d.panels[0]?.title;
  if (!multi) {
    const panel = d.panels[0];
    if (panel) {
      out.push(`steps: ${panel.steps}`);
      out.push('');
      out.push('signals:');
      if (!panel.rows.length) out.push('  []');
      for (const r of panel.rows) out.push(signalLine(r));
      out.push('');
    }
    return out;
  }

  out.push('');
  out.push('panels:');
  for (const panel of d.panels) {
    if (panel.title) out.push(`  - title: ${q(panel.title)}`);
    else out.push('  - title: ""');
    out.push(`    steps: ${panel.steps}`);
    out.push('    signals:');
    if (!panel.rows.length) out.push('      []');
    for (const r of panel.rows) out.push('    ' + signalLine(r));
  }
  out.push('');
  return out;
}

export function serialize(d: Diagram): string {
  return [`# FPGA Diagram · ${d.kind}`, ...sceneLines(d)].join('\n');
}

/**
 * 整份文件：只有一张图时写单图格式（保持文件干净、AI 好写）；
 * 多张图时写多视图格式（页签），互相不覆盖。
 */
export function serializeFile(file: SceneFile): string {
  if (file.scenes.length <= 1) return serialize(file.scenes[0]);
  const out: string[] = ['# FPGA Diagram · 多视图（scenes）—— 页签切换，内容互不覆盖'];
  const active = Math.min(Math.max(0, file.active), file.scenes.length - 1);
  if (active) out.push(`active: ${active}`);
  out.push('scenes:');
  for (const scene of file.scenes) {
    const lines = sceneLines(scene);
    const header = scene.title || scene.kind;
    out.push(`  # ${header}`);
    lines.forEach((l, i) => {
      if (!l.trim()) return;
      out.push(i === 0 ? `  - ${l}` : `    ${l}`);
    });
  }
  out.push('');
  return out.join('\n');
}

/**
 * 只改写 pos 字段，保留用户/AI 写的排版与注释。
 * 用于在画布上拖动节点后的回写。失败返回 null，调用方退回整文件序列化。
 */
export function patchPositions(text: string, d: Diagram): string | null {
  const lines = text.split(/\r?\n/);
  const want = new Map<string, [number, number]>();
  for (const nd of d.nodes) if (nd.pos) want.set(nd.id, [Math.round(nd.pos[0]), Math.round(nd.pos[1])]);
  if (!want.size) return text;

  let secStart = -1;
  let secIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(nodes|states)\s*:\s*(#.*)?$/);
    if (m) {
      secStart = i;
      secIndent = m[1].length;
      break;
    }
  }
  if (secStart < 0) return null;

  const items: { start: number; end: number; id?: string }[] = [];
  for (let i = secStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^\s*/)![0].length;
    if (indent <= secIndent) break;
    const m = line.match(/^(\s*)-\s*(.*)$/);
    if (m) {
      if (items.length) items[items.length - 1].end = i;
      items.push({ start: i, end: i + 1 });
      const idm = m[2].match(/(?:^|[,{\s])id\s*:\s*("([^"]*)"|'([^']*)'|([^,}\s]+))/);
      if (idm) items[items.length - 1].id = idm[2] ?? idm[3] ?? idm[4];
    }
  }
  if (items.length) items[items.length - 1].end = Math.min(items[items.length - 1].end, lines.length);

  if (items.length !== d.nodes.length) return null;
  for (let k = 0; k < items.length; k++) {
    if (items[k].id !== d.nodes[k].id) return null;
  }

  const out = lines.slice();
  for (let k = 0; k < items.length; k++) {
    const nd = d.nodes[k];
    const pos = want.get(nd.id);
    if (!pos) continue;
    const it = items[k];
    const startLine = out[it.start];
    const posRe = /pos\s*:\s*\[[^\]]*\]/;
    if (posRe.test(startLine)) {
      out[it.start] = startLine.replace(posRe, `pos: [${pos[0]}, ${pos[1]}]`);
      continue;
    }
    let replaced = false;
    for (let i = it.start + 1; i < it.end; i++) {
      if (posRe.test(out[i])) {
        out[i] = out[i].replace(posRe, `pos: [${pos[0]}, ${pos[1]}]`);
        replaced = true;
        break;
      }
    }
    if (replaced) continue;

    if (startLine.includes('{')) {
      const close = startLine.lastIndexOf('}');
      if (close < 0) return null;
      out[it.start] = `${startLine.slice(0, close).replace(/\s*$/, '')}, pos: [${pos[0]}, ${pos[1]}]${startLine.slice(close)}`;
    } else {
      const indent = startLine.match(/^\s*/)![0].length + 2;
      out.splice(it.start + 1, 0, `${' '.repeat(indent)}pos: [${pos[0]}, ${pos[1]}]`);
      for (let j = k + 1; j < items.length; j++) {
        items[j].start += 1;
        items[j].end += 1;
      }
      it.end += 1;
    }
  }
  return out.join('\n');
}
