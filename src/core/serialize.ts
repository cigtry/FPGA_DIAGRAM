import { Diagram, DiagramEdge, DiagramNode, SceneFile, TimingRow, isV2, shapeOf } from './model';

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
  // 统一用紧凑字符串写法：位宽拼进名字（解析端会从 [19:0] 提取回 width），
  // 方向用 < > <> 后缀。这样端口能内联在节点的单行 {…} 里，往返无损。
  const groups: string[] = [];
  for (const side of ['l', 'r', 't', 'b'] as const) {
    const list = nd.ports
      .filter((p) => p.side === side)
      .map((p) => {
        const w = p.width ? `[${p.width}]` : '';
        const base = `${p.name}${w}`;
        return p.dir === 'both' ? `${base}<>` : p.dir === 'out' ? `${base}>` : p.dir === 'in' ? `${base}<` : base;
      });
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
  // 拐点 / 视觉覆盖 / 端点映射任一存在时，退回字段写法（箭头简写放不下这些）
  const needsObj = from.startsWith('{') || to.startsWith('{') || !!e.waypoints?.length || !!e.visual;
  if (needsObj) {
    const obj = [
      `from: ${from}`,
      `to: ${to}`,
      e.arrow !== 'end' ? `arrow: ${e.arrow}` : '',
      e.label ? `label: ${q(e.label)}` : '',
      e.action ? `action: ${q(e.action)}` : '',
      e.style !== 'wire' ? `style: ${e.style}` : '',
      e.route !== 'orth' ? `route: ${e.route}` : '',
      e.waypoints?.length ? `waypoints: [${e.waypoints.map((p) => `[${p[0]}, ${p[1]}]`).join(', ')}]` : '',
      e.visual
        ? `visual: {${[
            e.visual.stroke ? `stroke: ${q(e.visual.stroke)}` : '',
            e.visual.color ? `color: ${q(e.visual.color)}` : '',
            e.visual.strokeWidth ? `strokeWidth: ${e.visual.strokeWidth}` : '',
            e.visual.dashed ? 'dashed: true' : '',
          ]
            .filter(Boolean)
            .join(', ')}}`
        : '',
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
  // 新增的两种分层类型用 diagram_type 写回；旧三种继续写 kind，老工具链读得懂
  const kindField = d.kind === 'system_block' || d.kind === 'schematic' ? 'diagram_type' : 'kind';
  out.push(`${kindField}: ${d.kind}`);
  if (d.title) out.push(`title: ${q(d.title)}`);
  const optLines: string[] = [];
  if (d.options.direction !== 'LR') optLines.push(`  direction: ${d.options.direction}`);
  if (!['auto', 'layered', 'circular'].includes(d.options.layout)) optLines.push(`  strategy: ${d.options.layout}`);
  else if (d.options.layout !== 'auto') optLines.push(`  layout: ${d.options.layout}`);
  if (Number(d.options.nodeSpacing) > 0) optLines.push(`  nodeSpacing: ${d.options.nodeSpacing}`);
  if (Number(d.options.layerSpacing) > 0) optLines.push(`  layerSpacing: ${d.options.layerSpacing}`);
  if (optLines.length) {
    out.push('layout:');
    for (const l of optLines) out.push(l);
  }
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
      if (nd.dash && !nd.style) fields.push('style: dashed');
      if (nd.titlePos === 'br') fields.push('titlePos: br');
    }
    if (nd.style) {
      const sv: string[] = [];
      if (nd.style.fill) sv.push(`fill: ${q(nd.style.fill)}`);
      if (nd.style.stroke) sv.push(`stroke: ${q(nd.style.stroke)}`);
      if (nd.style.strokeWidth) sv.push(`strokeWidth: ${nd.style.strokeWidth}`);
      if (nd.style.textColor) sv.push(`textColor: ${q(nd.style.textColor)}`);
      if (nd.style.dashed || nd.dash) sv.push('dashed: true');
      if (sv.length) fields.push(`style: {${sv.join(', ')}}`);
    }
    if (nd.collapsed) fields.push('collapsed: true');
    if (nd.data && Object.keys(nd.data).length) fields.push(`data: ${JSON.stringify(nd.data)}`);
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

function signalLine(r: TimingRow, indent = '  '): string {
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
  if (r.type === 'bus' && r.width) fields.push(`width: ${q(r.width)}`);
  if (r.order !== undefined) fields.push(`order: ${r.order}`);
  if (r.color) fields.push(`color: ${q(r.color)}`);
  // group 的子信号作为 children 内联数组，保持单行映射，避免 YAML 缩进歧义
  if (r.type === 'group' && r.children?.length) {
    const kids = r.children.map((c) => {
      const cf = [`name: ${q(c.name)}`, `type: ${c.type}`];
      if (c.values?.length) cf.push(`values: ${q(c.values.map((v) => (v === '' ? '.' : v)).join(' '))}`);
      if (c.width) cf.push(`width: ${q(c.width)}`);
      if (c.order !== undefined) cf.push(`order: ${c.order}`);
      return `{${cf.join(', ')}}`;
    });
    fields.push(`children: [${kids.join(', ')}]`);
  }
  return `${indent}- {${fields.join(', ')}}`;
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
    for (const r of panel.rows) out.push(signalLine(r, '      '));
  }
  out.push('');
  return out;
}

export function serialize(d: Diagram): string {
  return [`# FPGA Diagram · ${d.kind}`, ...sceneLines(d)].join('\n');
}

/** v2 文档头：version / meta / options */
function v2Header(file: SceneFile): string[] {
  const out: string[] = ['# FPGA Diagram · v2.0'];
  out.push(`version: '${file.version ?? '2.0'}'`);
  if (file.meta && Object.keys(file.meta).length) {
    out.push('meta:');
    for (const k of ['title', 'author', 'created', 'modified'] as const) {
      const v = file.meta[k];
      if (v) out.push(`  ${k}: ${q(v)}`);
    }
  }
  if (file.options && Object.keys(file.options).length) {
    out.push('options:');
    const o = file.options;
    if (o.grid !== undefined) out.push(`  grid: ${o.grid}`);
    if (o.gridSize) out.push(`  gridSize: ${o.gridSize}`);
    if (o.snapToGrid !== undefined) out.push(`  snapToGrid: ${o.snapToGrid}`);
    if (o.fontFamily) out.push(`  fontFamily: ${q(o.fontFamily)}`);
    if (o.fontSize) out.push(`  fontSize: ${o.fontSize}`);
  }
  return out;
}

/**
 * 整份文件：只有一张图时写单图格式（保持文件干净、AI 好写）；
 * 多张图时写多视图格式（页签），互相不覆盖。
 * v2 文档会带上 version/meta/options 头。
 */
export function serializeFile(file: SceneFile): string {
  const v2 = isV2(file);

  // v1 且单图：维持老的单图格式，一个字节都不多写
  if (!v2 && file.scenes.length <= 1) return serialize(file.scenes[0]);

  // 多视图的 v1：老格式
  if (!v2) {
    const out: string[] = ['# FPGA Diagram · 多视图（scenes）—— 页签切换，内容互不覆盖'];
    const active = Math.min(Math.max(0, file.active), file.scenes.length - 1);
    if (active) out.push(`active: ${active}`);
    out.push('scenes:');
    for (const scene of file.scenes) {
      const lines = sceneLines(scene);
      out.push(`  # ${scene.title || scene.kind}`);
      lines.forEach((l, i) => {
        if (!l.trim()) return;
        out.push(i === 0 ? `  - ${l}` : `    ${l}`);
      });
    }
    out.push('');
    return out.join('\n');
  }

  // v2：version/meta/options 头 + scenes 列表（单图也包一层，工具链统一）
  const out = v2Header(file);
  const active = Math.min(Math.max(0, file.active), file.scenes.length - 1);
  if (active) out.push(`active: ${active}`);
  out.push('scenes:');
  for (const scene of file.scenes) {
    const body = sceneLines(scene);
    const scLines = [`id: ${q(scene.id ?? `${scene.kind}-1`)}`, ...body];
    if (scene.title) out.push(`  # ${scene.title}`);
    scLines.forEach((l, i) => {
      out.push(i === 0 ? `  - ${l}` : l.trim() ? `    ${l}` : '');
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
