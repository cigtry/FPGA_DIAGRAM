import {
  BLOCK_SHAPES,
  Diagram,
  DiagramEdge,
  DiagramNode,
  FSM_SHAPES,
  KIND_LABEL,
  Kind,
  Side,
  TimingPanel,
  TimingRow,
  emptyDiagram,
  emptyTimingPanel,
  shapeOf,
  syncClockFreqs,
} from '../core/model';
import { Diagnostic, parseFile } from '../core/parse';
import { edgeMidpoint, effectiveValues, freqLabel, portAnchor, render, resolveEdge, svgDocument } from '../core/render';
import { patchPositions, serializeFile } from '../core/serialize';
import { sample } from '../core/examples';
import { Palette, ThemeName, palette } from '../core/theme';
import { esc } from '../core/text';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(s: any): void;
};
const vscode = acquireVsCodeApi();

type Pt = { x: number; y: number };

const S: {
  kind: Kind;
  scenes: Diagram[];
  active: number;
  doc: Diagram;
  fileText: string;
  lastPosted: string;
  diags: Diagnostic[];
  view: { x: number; y: number; k: number };
  sel: { nodes: string[]; edges: string[]; panel: number | null; row: number | null };
  activePanel: number;
  hover: string | null;
  grid: boolean;
  snap: boolean;
  brush: 'toggle' | '0' | '1' | 'z' | 'x' | 'value';
  res: { w: number; h: number };
  drag: any;
  history: string[];
  future: string[];
  posOnly: boolean;
  dropEdge: string | null;
  ready: boolean;
} = {
  kind: 'block',
  scenes: [emptyDiagram('block')],
  active: 0,
  doc: emptyDiagram('block'),
  fileText: '',
  lastPosted: '',
  diags: [],
  view: { x: 0, y: 0, k: 1 },
  sel: { nodes: [], edges: [], panel: null, row: null },
  activePanel: 0,
  hover: null,
  grid: true,
  snap: true,
  brush: 'toggle',
  res: { w: 0, h: 0 },
  drag: null,
  history: [],
  future: [],
  posOnly: false,
  dropEdge: null,
  ready: false,
};

let P: Palette = palette('light');
const stage = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('canvas') as unknown as SVGSVGElement;
const gridSvg = document.getElementById('grid') as unknown as SVGSVGElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const toolbar = document.getElementById('toolbar') as HTMLDivElement;
const paletteEl = document.getElementById('palette') as HTMLDivElement;
const inspectorEl = document.getElementById('inspector') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
/** 页签条：旧宿主页面里可能没有，paintTabs 会跳过 */
const tabsEl = document.getElementById('tabs') as HTMLDivElement | null;

// ------------------------------------------------------------------ utils

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function detectTheme(): ThemeName {
  const c = document.body.classList;
  return c.contains('vscode-dark') || c.contains('vscode-high-contrast') ? 'dark' : 'light';
}

function byId<T extends DiagramNode | undefined>(id: string): T {
  return S.doc.nodes.find((n) => n.id === id) as T;
}

function selNode(): DiagramNode | null {
  return S.sel.nodes.length === 1 ? (S.doc.nodes.find((n) => n.id === S.sel.nodes[0]) ?? null) : null;
}

function selEdge() {
  return S.sel.edges.length === 1 ? (S.doc.edges.find((e) => e.id === S.sel.edges[0]) ?? null) : null;
}

/** 当前正在编辑的那组时序 */
function curPanel(): TimingPanel | null {
  return S.doc.panels[S.activePanel] ?? S.doc.panels[0] ?? null;
}

/** 选中的信号行（时序） */
function selRow(): { row: TimingRow; panel: TimingPanel; panelIndex: number; index: number } | null {
  const panelIndex = S.sel.panel ?? S.activePanel;
  const panel = S.doc.panels[panelIndex];
  if (!panel || S.sel.row === null) return null;
  const row = panel.rows[S.sel.row];
  return row ? { row, panel, panelIndex, index: S.sel.row } : null;
}

function toUser(ev: { clientX: number; clientY: number }): Pt {
  const r = stage.getBoundingClientRect();
  return { x: S.view.x + (ev.clientX - r.left) / S.view.k, y: S.view.y + (ev.clientY - r.top) / S.view.k };
}

function toScreen(p: Pt): Pt {
  const r = stage.getBoundingClientRect();
  return { x: (p.x - S.view.x) * S.view.k, y: (p.y - S.view.y) * S.view.k };
}

// ------------------------------------------------------------------ render

function paint(): void {
  const res = render(S.doc, {
    theme: P,
    selection: S.sel.nodes,
    selEdges: S.sel.edges,
    handles: S.sel.nodes.length === 1 && !S.sel.edges.length,
    anchorsOn: S.hover ?? (S.sel.nodes.length === 1 ? S.sel.nodes[0] : null),
    dropEdge: S.dropEdge ?? undefined,
    selRow: S.sel.row !== null ? { panel: S.sel.panel ?? S.activePanel, row: S.sel.row } : null,
    interactive: true,
  });
  S.res = { w: res.width, h: res.height };
  canvas.innerHTML = res.body;
  applyView();
  paintStatus();
}

function applyView(): void {
  const r = stage.getBoundingClientRect();
  const vb = `${S.view.x} ${S.view.y} ${r.width / S.view.k} ${r.height / S.view.k}`;
  canvas.setAttribute('viewBox', vb);
  gridSvg.setAttribute('viewBox', vb);
  ctxZoomLabel();
}

function paintGrid(): void {
  const style = S.grid
    ? `<defs><pattern id="gp" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0 L0 0 0 20" fill="none" stroke="${P.grid}" stroke-width="1"/></pattern></defs><rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#gp)"/>`
    : '';
  gridSvg.innerHTML = style;
}

function ctxZoomLabel(): void {
  const z = document.getElementById('zoom-label');
  if (z) z.textContent = Math.round(S.view.k * 100) + '%';
}

function paintStatus(): void {
  const bits: string[] = [];
  if (S.doc.kind === 'timing') {
    const rows = S.doc.panels.reduce((s, p) => s + p.rows.length, 0);
    bits.push(`${S.doc.panels.length} 组 / ${rows} 条信号`, `每拍 ${S.doc.tick ?? 10} ns`);
  } else {
    bits.push(`${S.doc.nodes.length} 节点`, `${S.doc.edges.length} 连线`);
  }
  const errs = S.diags.filter((d) => d.severity === 'error');
  const warns = S.diags.filter((d) => d.severity === 'warning');
  const html =
    bits.map((b) => `<span>${esc(b)}</span>`).join('') +
    (errs.length ? `<span class="err">✖ ${errs.length} 个语法错误</span>` : '') +
    (warns.length ? `<span class="warn">⚠ ${warns.length} 个提示</span>` : '') +
    `<span style="flex:1"></span>` +
    `<span>${esc(hintText())}</span>`;
  statusEl.innerHTML = html;
}

function hintText(): string {
  if (S.doc.kind === 'timing') return '单击/拖拽画电平 · 总线用「值…」笔刷 · 双击信号名或总线值可改';
  if (S.sel.nodes.length > 1) return '已选中多个：可整体拖动，或用工具栏对齐';
  return '拖动节点移动 · 拖圆点连线 · 拖图形到连线上插入 · 双击改文字 · 滚轮缩放';
}

// ------------------------------------------------------------------ history & save

/** 历史快照覆盖所有视图，切换页签/改内容都能整体回退 */
function snapshot(): void {
  S.history.push(JSON.stringify({ scenes: S.scenes, active: S.active }));
  if (S.history.length > 120) S.history.shift();
  S.future.length = 0;
  paintToolbar();
}

function restore(json: string): void {
  const snap = JSON.parse(json) as { scenes: Diagram[]; active: number };
  S.scenes = snap.scenes?.length ? snap.scenes : [emptyDiagram('block')];
  S.active = Math.min(Math.max(0, snap.active ?? 0), S.scenes.length - 1);
  S.doc = S.scenes[S.active];
  S.kind = S.doc.kind;
  const ids = new Set(S.doc.nodes.map((n) => n.id));
  S.sel = {
    nodes: S.sel.nodes.filter((id) => ids.has(id)),
    edges: S.sel.edges.filter((id) => S.doc.edges.some((e) => e.id === id)),
    panel: null,
    row: null,
  };
  if (S.activePanel >= S.doc.panels.length) S.activePanel = 0;
  paint();
  paintTabs();
  paintPalette();
  paintInspector();
  save();
}

function undo(): void {
  const prev = S.history.pop();
  if (!prev) return;
  S.future.push(JSON.stringify({ scenes: S.scenes, active: S.active }));
  restore(prev);
}

function redo(): void {
  const next = S.future.pop();
  if (!next) return;
  S.history.push(JSON.stringify({ scenes: S.scenes, active: S.active }));
  restore(next);
}

let saveTimer = 0;
/** 结构性改动：整文件重写；posOnly=true 时只回写坐标，保留注释与排版 */
function save(posOnly = false): void {
  if (!posOnly) S.posOnly = false;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 220);
}

function savePos(): void {
  S.posOnly = true;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 220);
}

function flushSave(): void {
  let text: string | null = null;
  // 单视图文件可以只改 pos，保住用户手写的注释；多视图文件整体重写
  if (S.posOnly && S.scenes.length === 1) text = patchPositions(S.fileText, S.doc);
  if (text === null) text = serializeFile({ scenes: S.scenes, active: S.active });
  if (text === S.lastPosted) return;
  S.fileText = text;
  S.lastPosted = text;
  S.posOnly = false;
  vscode.postMessage({ type: 'edit', text });
}

// ------------------------------------------------------------------ toolbar

function tbBtn(label: string, title: string, onClick: () => void, opts: { id?: string; active?: boolean; disabled?: boolean } = {}) {
  const b = el('button', 'tb-btn', label);
  b.title = title;
  if (opts.id) b.id = opts.id;
  if (opts.active) b.classList.add('on');
  b.disabled = !!opts.disabled;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

function paintToolbar(): void {
  toolbar.innerHTML = '';
  toolbar.appendChild(tbBtn('↶', '撤销 (Ctrl+Z)', undo, { disabled: !S.history.length }));
  toolbar.appendChild(tbBtn('↷', '重做 (Ctrl+Y)', redo, { disabled: !S.future.length }));
  toolbar.appendChild(tbBtn('删除', '删除选中 (Delete)', deleteSelection, { disabled: !S.sel.nodes.length && !S.sel.edges.length }));
  toolbar.appendChild(tbBtn('复制', '复制选中 (Ctrl+D)', duplicateSelection, { disabled: !S.sel.nodes.length }));

  if (S.sel.nodes.length > 1) {
    toolbar.appendChild(el('div', 'tb-sep'));
    const group = el('div', 'tb-group');
    const align = (how: string) => () => alignSelection(how);
    group.appendChild(tbBtn('左', '左对齐', align('left')));
    group.appendChild(tbBtn('中', '水平居中', align('hcenter')));
    group.appendChild(tbBtn('右', '右对齐', align('right')));
    group.appendChild(tbBtn('上', '顶对齐', align('top')));
    group.appendChild(tbBtn('竖中', '垂直居中', align('vcenter')));
    group.appendChild(tbBtn('下', '底对齐', align('bottom')));
    toolbar.appendChild(group);
  }

  toolbar.appendChild(el('div', 'tb-sep'));
  toolbar.appendChild(
    tbBtn('网格', '显示网格', () => {
      S.grid = !S.grid;
      paintGrid();
      paintToolbar();
    }, { active: S.grid }),
  );
  toolbar.appendChild(
    tbBtn('吸附', '拖动时对齐 5px 网格', () => {
      S.snap = !S.snap;
      paintToolbar();
    }, { active: S.snap }),
  );

  if (S.doc.kind !== 'timing') {
    const manual = S.doc.options.layout === 'manual';
    toolbar.appendChild(
      tbBtn(manual ? '手工布局' : '自动布局', '切换布局模式', () => {
        snapshot();
        if (manual) {
          S.doc.options.layout = 'auto';
          for (const n of S.doc.nodes) n.pos = undefined;
        } else {
          S.doc.options.layout = 'manual';
          for (const n of S.doc.nodes) n.pos = [n.x, n.y];
        }
        paint();
        paintToolbar();
        save();
      }, { active: manual }),
    );
    toolbar.appendChild(
      tbBtn('重排', '清除所有手工位置，按连接关系重新自动布局', () => {
        snapshot();
        for (const n of S.doc.nodes) n.pos = undefined;
        S.doc.options.layout = 'auto';
        paint();
        paintToolbar();
        save();
      }),
    );
  }

  toolbar.appendChild(el('div', 'tb-sep'));
  toolbar.appendChild(
    tbBtn('−', '缩小', () => {
      S.view.k = Math.max(0.2, S.view.k * 0.85);
      applyView();
    }),
  );
  toolbar.appendChild(tbBtn('100%', '缩放比例，点击复位', () => {
    S.view.k = 1;
    applyView();
  }, { id: 'zoom-label' }));
  toolbar.appendChild(
    tbBtn('+', '放大', () => {
      S.view.k = Math.min(4, S.view.k * 1.18);
      applyView();
    }),
  );
  toolbar.appendChild(tbBtn('适应', '缩放到适应窗口 (Ctrl+0)', () => fitView()));

  toolbar.appendChild(el('div', 'tb-sep'));
  toolbar.appendChild(tbBtn('导出 SVG', '导出为矢量图', () => exportSvg()));
  toolbar.appendChild(tbBtn('导出 PNG', '导出为位图（2x）', () => exportPng()));
  toolbar.appendChild(tbBtn('源码', '切换到文本视图编辑 DSL', () => vscode.postMessage({ type: 'openSource' })));
}

// ------------------------------------------------------------------ tabs（多视图）

const KIND_ICON: Record<Kind, string> = { block: '▤', fsm: '◯', timing: '〜' };

function sceneLabel(d: Diagram, i: number): string {
  return d.title?.trim() || `${KIND_LABEL[d.kind]}${i + 1}`;
}

function paintTabs(): void {
  if (!tabsEl) return;
  tabsEl.innerHTML = '';
  S.scenes.forEach((sc, i) => {
    const tab = el('div', 'tab' + (i === S.active ? ' active' : ''));
    tab.title = `${KIND_LABEL[sc.kind]}${sc.title ? ' · ' + sc.title : ''}（双击重命名）`;
    tab.appendChild(el('span', 'tab-ico', KIND_ICON[sc.kind]));
    tab.appendChild(el('span', 'tab-name', sceneLabel(sc, i)));
    if (S.scenes.length > 1) {
      const x = el('span', 'tab-x', '×');
      x.title = '删除这个视图';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteScene(i);
      });
      tab.appendChild(x);
    }
    tab.addEventListener('click', () => switchScene(i));
    tab.addEventListener('dblclick', () => renameScene(i));
    tabsEl.appendChild(tab);
  });
  const add = el('button', 'tab-add', '＋');
  add.title = '新增视图（框图 / 状态机 / 时序组），原内容不会丢失';
  add.addEventListener('click', () => {
    const r = add.getBoundingClientRect();
    openPopup(r.left, r.bottom + 4, [
      ['系统框图（流程图）', () => addScene('block')],
      ['状态机', () => addScene('fsm')],
      ['时序波形', () => addScene('timing')],
    ]);
  });
  tabsEl.appendChild(add);
}

function starterTimingPanel(steps = 16): TimingPanel {
  const panel = emptyTimingPanel(steps);
  panel.rows.push({ name: 'clk', type: 'clock', freq: 100, period: 2, duty: 0.5, phase: 0, values: [] });
  panel.rows.push({ name: 'sig', type: 'logic', values: new Array(steps).fill('0') });
  return panel;
}

function switchScene(i: number): void {
  if (i < 0 || i >= S.scenes.length || i === S.active) return;
  S.active = i;
  S.doc = S.scenes[i];
  S.kind = S.doc.kind;
  S.activePanel = 0;
  S.sel = { nodes: [], edges: [], panel: null, row: null };
  S.hover = null;
  paintTabs();
  paintPalette();
  paintInspector();
  paint();
}

function addScene(kind: Kind): void {
  snapshot();
  const sc = emptyDiagram(kind);
  sc.id = `${kind}${S.scenes.length + 1}`;
  if (kind === 'timing') sc.panels.push(starterTimingPanel());
  S.scenes.push(sc);
  S.active = S.scenes.length - 1;
  S.doc = sc;
  S.kind = kind;
  S.activePanel = 0;
  S.sel = { nodes: [], edges: [], panel: null, row: null };
  paintTabs();
  paintPalette();
  paintInspector();
  paint();
  paintToolbar();
  save();
  setTimeout(fitView, 30);
}

function deleteScene(i: number): void {
  if (S.scenes.length <= 1) return;
  snapshot();
  S.scenes.splice(i, 1);
  S.active = Math.min(S.active, S.scenes.length - 1);
  if (i < S.active) S.active -= 1;
  S.doc = S.scenes[S.active];
  S.kind = S.doc.kind;
  S.activePanel = 0;
  S.sel = { nodes: [], edges: [], panel: null, row: null };
  paintTabs();
  paintPalette();
  paintInspector();
  paint();
  save();
}

function renameScene(i: number): void {
  const sc = S.scenes[i];
  if (!sc) return;
  const node = tabsEl?.querySelectorAll('.tab')[i] as HTMLElement | undefined;
  const r = node?.getBoundingClientRect();
  editInlineFixed(r ? r.left : 100, r ? r.bottom + 2 : 60, r ? Math.max(90, r.width) : 130, sc.title ?? '', (v) => {
    snapshot();
    sc.title = v.trim() || undefined;
    paintTabs();
    paint();
    save();
  });
}

// ------------------------------------------------------------------ palette

function previewOf(type: string): string {
  const kind = S.doc.kind;
  const shape = shapeOf(type, kind);
  const tmp: Diagram = {
    kind,
    nodes: [{ id: 'x', type, label: '', x: 0, y: 0, w: shape.w, h: shape.h, ports: [], size: [shape.w, shape.h] }],
    edges: [],
    panels: [],
    tick: 10,
    options: { direction: 'LR', layout: 'manual' },
    warnings: [],
  };
  const r = render(tmp, { theme: P, padding: 5 });
  const body = r.body.replace(/<defs>[\s\S]*?<\/defs>/, '');
  return `<svg viewBox="0 0 ${r.width} ${r.height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

function paintTimingPalette(): void {
  paletteEl.innerHTML = '';
  const panel = curPanel();

  paletteEl.appendChild(el('div', 'pal-title', '波形笔刷'));
  const brush = el('div', 'brush-row');
  ([
    ['toggle', '翻转', '单比特：点一下翻转电平'],
    ['0', '0', '画成低电平'],
    ['1', '1', '画成高电平'],
    ['z', 'Z', '高阻（虚线）'],
    ['x', 'X', '未知（打叉）'],
    ['value', '值…', '总线：点格子输入值，值保持到下一次修改'],
  ] as const).forEach(([b, label, tip]) => {
    const btn = el('button', S.brush === b ? 'on' : '', label);
    btn.title = tip;
    btn.addEventListener('click', () => {
      S.brush = b;
      paintTimingPalette();
    });
    brush.appendChild(btn);
  });
  paletteEl.appendChild(brush);

  // ---- 时序组 ----
  const head = el('div', 'pal-title', '时序组');
  const addPanel = el('button', 'pal-mini', '＋ 组');
  addPanel.title = '同一张图里再加一组时序（写通道 / 读通道 / 复位…）';
  addPanel.addEventListener('click', () => addTimingPanel());
  head.appendChild(addPanel);
  paletteEl.appendChild(head);

  const panelList = el('div', 'sig-list');
  S.doc.panels.forEach((p, i) => {
    const item = el('div', 'sig-item panel-item' + (i === S.activePanel ? ' on' : ''));
    item.title = '单击切换当前组，双击改组名';
    item.appendChild(el('span', 'sig-type', '▤'));
    item.appendChild(el('span', 'sig-name', p.title || `时序组 ${i + 1}`));
    item.appendChild(el('span', 'sig-meta', `${p.steps} 拍`));
    if (S.doc.panels.length > 1) {
      const x = el('span', 'sig-x', '×');
      x.title = '删除这一组时序';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteTimingPanel(i);
      });
      item.appendChild(x);
    }
    item.addEventListener('click', () => {
      S.activePanel = i;
      S.sel = { nodes: [], edges: [], panel: i, row: null };
      paintTimingPalette();
      paint();
      paintInspector();
    });
    item.addEventListener('dblclick', () => renamePanel(i));
    panelList.appendChild(item);
  });
  paletteEl.appendChild(panelList);

  if (panel) {
    const len = el('div', 'brush-row step-row');
    const mk = (d: number, label: string) => {
      const b = el('button', '', label);
      b.title = `当前组 ${d > 0 ? '加' : '减'} ${Math.abs(d)} 拍`;
      b.addEventListener('click', () => resizeSteps(d));
      return b;
    };
    len.append(mk(-4, '−4'), mk(-1, '−1'), mk(1, '+1'), mk(4, '+4'));
    paletteEl.appendChild(len);
  }

  // ---- 信号 ----
  const sigHead = el('div', 'pal-title', '信号');
  const addSig = el('button', 'pal-mini', '＋ 信号');
  addSig.title = '添加时钟 / 单比特 / 总线 / 分组标题';
  addSig.addEventListener('click', () => {
    const r = addSig.getBoundingClientRect();
    openPopup(r.left - 60, r.bottom + 4, [
      ['时钟（100MHz）', () => addTimingRow('clock')],
      ['单比特信号', () => addTimingRow('logic')],
      ['总线（可写 A0/D0…）', () => addTimingRow('bus')],
      ['分组标题', () => addTimingRow('group')],
    ]);
  });
  sigHead.appendChild(addSig);
  paletteEl.appendChild(sigHead);

  const list = el('div', 'sig-list');
  const rows = panel?.rows ?? [];
  if (!rows.length) list.appendChild(el('div', 'sig-empty', '还没有信号，点「＋ 信号」'));
  rows.forEach((row, i) => {
    const on = S.sel.panel === S.activePanel && S.sel.row === i;
    const item = el('div', 'sig-item' + (on ? ' on' : ''));
    item.appendChild(el('span', 'sig-type', row.type === 'clock' ? '⏱' : row.type === 'bus' ? '⇄' : row.type === 'group' ? '▬' : '⎍'));
    item.appendChild(el('span', 'sig-name', row.name));
    if (row.type === 'clock') item.appendChild(el('span', 'sig-meta', row.freq ? freqLabel(row.freq) : `${row.period ?? 2} 拍`));
    item.title = '单击选中，双击改名';
    item.addEventListener('click', () => {
      S.activePanel = S.sel.panel ?? S.activePanel;
      S.sel = { nodes: [], edges: [], panel: S.activePanel, row: i };
      paintTimingPalette();
      paint();
      paintInspector();
    });
    item.addEventListener('dblclick', (ev) => {
      const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      editInlineFixed(r.right - 120, r.top - 2, 116, row.name, (v) => {
        if (!v.trim()) return;
        snapshot();
        row.name = v.trim();
        paintTimingPalette();
        paint();
        save();
      });
    });
    list.appendChild(item);
  });
  paletteEl.appendChild(list);
}

function paintPalette(): void {
  paletteEl.innerHTML = '';
  if (S.doc.kind === 'timing') {
    paintTimingPalette();
    return;
  }

  const table = S.doc.kind === 'fsm' ? FSM_SHAPES : BLOCK_SHAPES;
  paletteEl.appendChild(el('div', 'pal-title', S.doc.kind === 'fsm' ? '状态图形' : '模块图形'));
  const grid = el('div', 'pal-grid');
  Object.entries(table).forEach(([type, shape]) => {
    const item = el('div', 'pal-item');
    const wrap = el('div');
    wrap.innerHTML = previewOf(type);
    if (wrap.firstElementChild) item.appendChild(wrap.firstElementChild);
    item.appendChild(el('span', '', shape.cn));
    item.title = `添加${shape.cn}（拖到连线上可插在中间）`;
    item.addEventListener('pointerdown', (ev) => startPaletteDrag(ev, type));
    item.addEventListener('click', () => {
      if (paletteDragged) {
        paletteDragged = false;
        return;
      }
      addNode(type);
    });
    grid.appendChild(item);
  });
  paletteEl.appendChild(grid);
}

// ------------------------------------------------------------------ inspector

function field(label: string, control: HTMLElement): HTMLElement {
  const box = el('div', 'field');
  box.appendChild(el('label', '', label));
  box.appendChild(control);
  return box;
}

function textInput(value: string, onChange: (v: string) => void, ph = ''): HTMLInputElement {
  const i = el('input');
  i.type = 'text';
  i.value = value;
  i.placeholder = ph;
  i.addEventListener('input', () => onChange(i.value));
  return i;
}

function numInput(value: number, onChange: (v: number) => void): HTMLInputElement {
  const i = el('input');
  i.type = 'number';
  i.value = String(Math.round(value));
  i.addEventListener('input', () => onChange(Number(i.value) || 0));
  return i;
}

function selectInput(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = el('select');
  for (const [v, label] of options) {
    const o = el('option', '', label);
    o.value = v;
    if (v === value) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function portsText(nd: DiagramNode, side: Side): string {
  return nd.ports.filter((p) => p.side === side).map((p) => p.name).join(', ');
}

function setPorts(nd: DiagramNode, side: Side, text: string): void {
  const names = text
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const other = nd.ports.filter((p) => p.side !== side);
  nd.ports = [
    ...other,
    ...names.map((nm) => ({ id: nm, name: nm, side })),
  ];
  for (const e of S.doc.edges) {
    const bad = (ep: { node: string; port?: string }) => ep.node === nd.id && ep.port && !nd.ports.some((p) => p.name === ep.port);
    if (bad(e.from)) e.from.port = undefined;
    if (bad(e.to)) e.to.port = undefined;
  }
}

function kindLabel(k: Kind): string {
  return KIND_LABEL[k];
}

/** 切换图表类型 = 跳到同类型的视图；没有就新建一个，原视图内容原地保留 */
function requestKind(target: Kind): void {
  if (target === S.doc.kind) return;
  const idx = S.scenes.findIndex((s) => s.kind === target);
  if (idx >= 0) switchScene(idx);
  else addScene(target);
}

function paintInspector(): void {
  inspectorEl.innerHTML = '';
  const diagBox = el('div');
  if (S.diags.length) {
    const ul = el('ul', 'diag-list');
    for (const d of S.diags.slice(0, 6)) {
      const li = el('li', d.severity === 'error' ? 'err' : '', `${d.line ? `第 ${d.line} 行：` : ''}${d.message}`);
      ul.appendChild(li);
    }
    diagBox.appendChild(ul);
    inspectorEl.appendChild(diagBox);
  }

  if (S.doc.kind === 'timing') return paintTimingInspector();

  const nd = selNode();
  if (nd) {
    inspectorEl.appendChild(el('div', 'insp-title', `节点 · ${shapeOf(nd.type, S.doc.kind).cn}`));
    inspectorEl.appendChild(el('div', 'insp-sub', `id: ${nd.id}（连线时用得到）`));
    if (nd.type !== 'init' && nd.type !== 'final' && nd.type !== 'junction') {
      inspectorEl.appendChild(field('标签', textInput(nd.label, (v) => { nd.label = v; paint(); save(); })));
      inspectorEl.appendChild(field('副标题', textInput(nd.sub ?? '', (v) => { nd.sub = v || undefined; paint(); save(); }, '可选，如位宽/说明')));
      const row = el('div', 'field-row');
      row.appendChild(field('宽', numInput(nd.w, (v) => { nd.w = Math.max(24, v); nd.size = [nd.w, nd.h]; paint(); save(); })));
      row.appendChild(field('高', numInput(nd.h, (v) => { nd.h = Math.max(24, v); nd.size = [nd.w, nd.h]; paint(); save(); })));
      inspectorEl.appendChild(row);
      inspectorEl.appendChild(field('左侧端口（逗号分隔）', textInput(portsText(nd, 'l'), (v) => { setPorts(nd, 'l', v); paint(); save(); }, 'clk, rst_n')));
      inspectorEl.appendChild(field('右侧端口（逗号分隔）', textInput(portsText(nd, 'r'), (v) => { setPorts(nd, 'r', v); paint(); save(); }, 'dout, valid')));
    }
    if (nd.type === 'frame') {
      const row2 = el('div', 'field-row');
      row2.appendChild(
        field(
          '边框',
          selectInput([['solid', '实线'], ['dashed', '虚线']], nd.dash ? 'dashed' : 'solid', (v) => {
            nd.dash = v === 'dashed' ? true : undefined;
            paint();
            save();
          }),
        ),
      );
      row2.appendChild(
        field(
          '标题位置',
          selectInput([['top', '顶部居中'], ['br', '右下角']], nd.titlePos === 'br' ? 'br' : 'top', (v) => {
            nd.titlePos = v === 'br' ? 'br' : undefined;
            paint();
            save();
          }),
        ),
      );
      inspectorEl.appendChild(row2);
    }
    if (nd.type === 'group') {
      inspectorEl.appendChild(
        field('包含节点（逗号分隔 id）', textInput((nd.children ?? []).join(', '), (v) => {
          nd.children = v.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
          paint();
          save();
        })),
      );
    }
    const del = el('button', 'mini-btn danger', '删除节点');
    del.addEventListener('click', () => deleteSelection());
    inspectorEl.appendChild(del);
    return;
  }

  const e = selEdge();
  if (e) {
    inspectorEl.appendChild(el('div', 'insp-title', '连线'));
    inspectorEl.appendChild(el('div', 'insp-sub', `${e.from.node}${e.from.port ? '.' + e.from.port : ''} → ${e.to.node}${e.to.port ? '.' + e.to.port : ''}`));
    inspectorEl.appendChild(field('标签', textInput(e.label ?? '', (v) => { e.label = v || undefined; paint(); save(); }, '如 24bit / start')));
    inspectorEl.appendChild(
      field(
        '类型',
        selectInput(
          [['wire', '信号'], ['bus', '总线'], ['clock', '时钟'], ['ctrl', '控制']],
          e.style,
          (v) => { e.style = v as any; paint(); save(); },
        ),
      ),
    );
    inspectorEl.appendChild(
      field(
        '走线',
        selectInput([['orth', '折线'], ['straight', '直线'], ['curve', '曲线']], e.route, (v) => { e.route = v as any; paint(); save(); }),
      ),
    );
    inspectorEl.appendChild(
      field(
        '箭头',
        selectInput([['end', '单向'], ['both', '双向'], ['none', '无']], e.arrow, (v) => { e.arrow = v as any; paint(); save(); }),
      ),
    );
    const ins = el('button', 'mini-btn', `在中间插入${S.doc.kind === 'fsm' ? '状态' : '模块'}`);
    ins.title = '也可直接把左侧图形拖到连线上，或选中连线按 Enter';
    ins.addEventListener('click', () => insertOnEdge(e.id, defaultInsertType()));
    inspectorEl.appendChild(ins);
    const del = el('button', 'mini-btn danger', '删除连线');
    del.addEventListener('click', () => deleteSelection());
    inspectorEl.appendChild(del);
    return;
  }

  inspectorEl.appendChild(el('div', 'insp-title', '图表属性'));
  const kindRow = el('div', 'kind-row');
  (['block', 'fsm', 'timing'] as Kind[]).forEach((k) => {
    const b = el('button', 'kind-btn' + (S.doc.kind === k ? ' active' : ''), KIND_LABEL[k]);
    b.title = k === S.doc.kind ? '当前视图' : `切到${KIND_LABEL[k]}视图（各自内容都保留）`;
    b.addEventListener('click', () => requestKind(k));
    kindRow.appendChild(b);
  });
  inspectorEl.appendChild(field('视图类型', kindRow));
  inspectorEl.appendChild(el('div', 'insp-hint', '切类型 = 切视图，内容不会互相覆盖；页签「＋」可再加一个。'));
  inspectorEl.appendChild(field('标题', textInput(S.doc.title ?? '', (v) => { S.doc.title = v || undefined; paint(); save(); }, '可选')));
  inspectorEl.appendChild(
    field(
      '布局方向',
      selectInput([['LR', '从左到右'], ['TB', '从上到下']], S.doc.options.direction, (v) => {
        S.doc.options.direction = v as any;
        paint();
        save();
      }),
    ),
  );
  inspectorEl.appendChild(
    field(
      '布局方式',
      selectInput(
        [['auto', '自动'], ['manual', '手工（保持位置）']],
        S.doc.options.layout === 'manual' ? 'manual' : 'auto',
        (v) => {
          snapshot();
          S.doc.options.layout = v as any;
          if (v === 'manual') for (const n of S.doc.nodes) n.pos = [n.x, n.y];
          else for (const n of S.doc.nodes) n.pos = undefined;
          paint();
          paintToolbar();
          save();
        },
      ),
    ),
  );
  const tip = el('div', 'insp-empty');
  tip.innerHTML = [
    '单击图形选中，拖动移动；',
    '从选中图形边上的圆点拖出连线；',
    '把左侧图形拖到连线上，可插在箭头中间；',
    '双击图形或连线改文字；',
    '<kbd>Delete</kbd> 删除，<kbd>Ctrl+Z</kbd> 撤销。',
  ].join('<br>');
  inspectorEl.appendChild(tip);
}

function floatInput(value: number, onChange: (v: number) => void, step = 1): HTMLInputElement {
  const i = el('input');
  i.type = 'number';
  i.step = String(step);
  i.value = String(value);
  i.addEventListener('input', () => onChange(Number(i.value) || 0));
  return i;
}

/** 频率 → 周期（拍）并保证时间基准够细，多时钟才对得齐 */
function setClockFreq(row: TimingRow, mhz: number): void {
  row.freq = Math.max(0, mhz);
  if (row.freq > 0) syncClockFreqs(S.doc);
}

function busSegments(row: TimingRow): { start: number; value: string }[] {
  const segs: { start: number; value: string }[] = [];
  row.values.forEach((v, i) => {
    if (v !== '') segs.push({ start: i, value: v });
  });
  return segs;
}

function paintSignalInspector(picked: { row: TimingRow; panel: TimingPanel; panelIndex: number; index: number }): void {
  const { row, panel, index } = picked;
  inspectorEl.appendChild(el('div', 'insp-title', `信号 · ${row.name}`));
  inspectorEl.appendChild(el('div', 'insp-sub', `${panel.title || `时序组 ${picked.panelIndex + 1}`} · 第 ${index + 1} 行`));

  inspectorEl.appendChild(field('名称', textInput(row.name, (v) => {
    row.name = v;
    paint();
    paintTimingPalette();
    save();
  })));

  inspectorEl.appendChild(field('类型', selectInput(
    [['clock', '时钟'], ['logic', '单比特'], ['bus', '总线'], ['group', '分组标题']],
    row.type,
    (v) => {
      snapshot();
      row.type = v as TimingRow['type'];
      if (row.type === 'clock') {
        if (!row.period) row.period = 2;
        if (!row.freq) row.freq = 100;
        syncClockFreqs(S.doc);
      }
      if (row.type === 'group') row.values = [];
      if (row.type === 'logic') row.values = row.values.map((x) => (x === '' ? '' : x));
      paint();
      paintTimingPalette();
      paintInspector();
      save();
    },
  )));

  if (row.type === 'clock') {
    const tick = S.doc.tick ?? 10;
    inspectorEl.appendChild(field('频率（MHz）', floatInput(row.freq ?? 100, (v) => {
      setClockFreq(row, v);
      paint();
      paintTimingPalette();
      save();
    }, 5)));
    const ns = row.freq ? 1000 / row.freq : (row.period ?? 2) * tick;
    inspectorEl.appendChild(el('div', 'insp-hint', `周期 ${row.period ?? 2} 拍 ≈ ${Number(ns.toFixed(2))} ns（每拍 ${tick} ns）`));
    inspectorEl.appendChild(field('占空比 0-1', floatInput(row.duty ?? 0.5, (v) => {
      row.duty = Math.min(0.95, Math.max(0.05, v));
      paint();
      save();
    }, 0.05)));
    inspectorEl.appendChild(field('相位（拍）', numInput(row.phase ?? 0, (v) => {
      row.phase = Math.round(v);
      paint();
      save();
    })));
  } else if (row.type === 'bus') {
    inspectorEl.appendChild(el('div', 'insp-sub', '总线规则：值从所在拍开始保持，直到下一段；空格=保持，z=断开'));
    const list = el('div', 'seg-list');
    const segs = busSegments(row);
    if (!segs.length) list.appendChild(el('div', 'sig-empty', '还没有值，点「＋ 段」加一段'));
    segs.forEach((seg, si) => {
      const line = el('div', 'seg-row');
      const at = el('input');
      at.type = 'number';
      at.min = '1';
      at.max = String(panel.steps);
      at.value = String(seg.start + 1);
      at.title = '第几拍开始（从 1 数）';
      at.addEventListener('change', () => {
        const nv = Math.min(panel.steps - 1, Math.max(0, Math.round(Number(at.value) || 1) - 1));
        if (nv === seg.start) return;
        row.values[seg.start] = '';
        row.values[nv] = seg.value;
        paint();
        save();
      });
      at.title = '第几拍开始（从 1 数）';
      const val = textInput(seg.value, (v) => {
        row.values[seg.start] = v.trim();
        paint();
        save();
      }, 'A0');
      val.title = '总线值，如 A0 / D0 / 0x1F';
      const del = el('button', 'seg-del', '×');
      del.title = '删除这一段（其后的值会接上）';
      del.addEventListener('click', () => {
        snapshot();
        row.values[seg.start] = '';
        paint();
        paintInspector();
        save();
      });
      line.append(at, val, del);
      list.appendChild(line);
      void si;
    });
    inspectorEl.appendChild(list);
    const addSeg = el('button', 'mini-btn', '＋ 段');
    addSeg.addEventListener('click', () => {
      snapshot();
      const segs2 = busSegments(row);
      const start = segs2.length ? Math.min(panel.steps - 1, segs2[segs2.length - 1].start + 1) : 0;
      row.values[start] = segs2.length ? 'DATA' : 'A0';
      paint();
      paintInspector();
      paintTimingPalette();
      save();
    });
    inspectorEl.appendChild(addSeg);
  } else if (row.type === 'logic') {
    const seq = row.values.map((v) => (v === '' ? '.' : v)).join(' ');
    inspectorEl.appendChild(field('逐拍电平（. 保持）', textInput(seq, (v) => {
      const parts = v.split(/[\s,]+/).filter((x) => x !== '');
      const vals: string[] = [];
      for (let i = 0; i < panel.steps; i++) {
        const t = (parts[i] ?? '.').toLowerCase();
        vals.push(t === '.' || t === '-' ? '' : t);
      }
      row.values = vals;
      paint();
      save();
    }, '0 1 1 0 . . .')));
    const rowBtns = el('div', 'field-row');
    const all0 = el('button', 'mini-btn', '全 0');
    all0.addEventListener('click', () => {
      snapshot();
      row.values = new Array(panel.steps).fill('0');
      paint();
      save();
    });
    const all1 = el('button', 'mini-btn', '全 1');
    all1.addEventListener('click', () => {
      snapshot();
      row.values = new Array(panel.steps).fill('1');
      paint();
      save();
    });
    rowBtns.append(all0, all1);
    inspectorEl.appendChild(rowBtns);
  }

  const moves = el('div', 'field-row');
  const up = el('button', 'mini-btn', '上移');
  up.addEventListener('click', () => moveRow(index, -1));
  const down = el('button', 'mini-btn', '下移');
  down.addEventListener('click', () => moveRow(index, 1));
  moves.append(up, down);
  inspectorEl.appendChild(moves);

  const del = el('button', 'mini-btn danger', '删除信号');
  const pi = picked.panelIndex;
  del.addEventListener('click', () => {
    snapshot();
    S.doc.panels[pi].rows.splice(index, 1);
    S.sel.row = null;
    paint();
    paintTimingPalette();
    paintInspector();
    save();
  });
  inspectorEl.appendChild(del);
}

function paintTimingInspector(): void {
  if (S.doc.kind !== 'timing') return;
  const picked = selRow();
  if (picked) {
    paintSignalInspector(picked);
    return;
  }

  inspectorEl.appendChild(el('div', 'insp-title', '图表属性'));
  const kindRow = el('div', 'kind-row');
  (['block', 'fsm', 'timing'] as Kind[]).forEach((k) => {
    const b = el('button', 'kind-btn' + (S.doc.kind === k ? ' active' : ''), KIND_LABEL[k]);
    b.title = k === S.doc.kind ? '当前视图' : `切到${KIND_LABEL[k]}视图（内容各自保留）`;
    b.addEventListener('click', () => requestKind(k));
    kindRow.appendChild(b);
  });
  inspectorEl.appendChild(field('视图类型', kindRow));
  inspectorEl.appendChild(el('div', 'insp-hint', '切类型 = 切视图，各自内容都留着；需要更多时序就在页签「＋」里加。'));
  inspectorEl.appendChild(field('标题', textInput(S.doc.title ?? '', (v) => {
    S.doc.title = v || undefined;
    paintTabs();
    paint();
    save();
  }, '可选')));
  inspectorEl.appendChild(field('每拍时间（ns）', floatInput(S.doc.tick ?? 10, (v) => {
    S.doc.tick = Math.max(0.1, v || 10);
    syncClockFreqs(S.doc);
    paint();
    paintTimingPalette();
    save();
  }, 1)));

  const panel = curPanel();
  if (panel) {
    inspectorEl.appendChild(el('div', 'insp-title', `当前时序组 ${S.activePanel + 1}`));
    inspectorEl.appendChild(field('组名', textInput(panel.title ?? '', (v) => {
      panel.title = v || undefined;
      paint();
      paintTimingPalette();
      save();
    }, '如 写通道')));
    inspectorEl.appendChild(field('拍数', numInput(panel.steps, (v) => {
      snapshot();
      setPanelSteps(panel, v);
      paint();
      paintTimingPalette();
      save();
    })));
  }

  const tip = el('div', 'insp-empty');
  tip.innerHTML = [
    '网格的每一列是「一拍」，时间轴按 ns 标；',
    '时钟填<strong>频率</strong>，多时钟会按最快时钟自动细分网格；',
    '总线用「值…」笔刷点格子，值从该拍保持到下一段；',
    '一行只有一条波形，多组时序请用「＋ 组」。',
  ].join('<br>');
  inspectorEl.appendChild(tip);
}

// ------------------------------------------------------------------ mutations

function addNode(type: string, at?: Pt): void {
  snapshot();
  const shape = shapeOf(type, S.doc.kind);
  const center = at
    ? { x: at.x - shape.w / 2, y: at.y - shape.h / 2 }
    : { x: S.view.x + stage.clientWidth / S.view.k / 2 - shape.w / 2, y: S.view.y + stage.clientHeight / S.view.k / 2 - shape.h / 2 };
  let id = type;
  let i = 1;
  while (S.doc.nodes.some((n) => n.id === id)) id = `${type}${++i}`;
  const nd: DiagramNode = {
    id,
    type,
    label: shape.cn,
    x: center.x,
    y: center.y,
    w: shape.w,
    h: shape.h,
    pos: [Math.round(center.x), Math.round(center.y)],
    size: [shape.w, shape.h],
    ports: [],
  };
  S.doc.nodes.push(nd);
  S.sel = { nodes: [id], edges: [], panel: null, row: null };
  paint();
  paintInspector();
  save();
  setTimeout(() => {
    const box = toScreen({ x: nd.x, y: nd.y });
    editInline(box.x, box.y, nd.w * S.view.k, nd.label, false, (v) => {
      nd.label = v;
      nd.pos = [nd.pos?.[0] ?? nd.x, nd.pos?.[1] ?? nd.y];
      paint();
      save();
    });
  }, 30);
}

function uniqueNodeId(type: string): string {
  let id = type;
  let i = 1;
  while (S.doc.nodes.some((n) => n.id === id)) id = `${type}${++i}`;
  return id;
}

function uniqueEdgeId(): string {
  let id = `e${Date.now().toString(36)}`;
  let i = 1;
  while (S.doc.edges.some((e) => e.id === id)) id = `e${Date.now().toString(36)}${++i}`;
  return id;
}

/** 这条连线（可见折线）的中点——插入图形的默认落点，保证压在原箭头中间 */
function edgeMidPoint(e: DiagramEdge): Pt | null {
  const mid = edgeMidpoint(S.doc, e);
  if (mid) return mid;
  const pair = resolveEdge(S.doc, e);
  if (!pair) return null;
  return { x: (pair.a.x + pair.b.x) / 2, y: (pair.a.y + pair.b.y) / 2 };
}

/** 从 src 指向 target 的那条边：箭头落在该边的中点，而不是拐角 */
function sideFacing(src: DiagramNode, target: DiagramNode): Side {
  const ax = src.x + src.w / 2;
  const ay = src.y + src.h / 2;
  const bx = target.x + target.w / 2;
  const by = target.y + target.h / 2;
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'r' : 'l';
  return dy >= 0 ? 'b' : 't';
}

/** 这个图形能否"串"在连线上（分组框、初始/结束态没有输入输出语义） */
function canSplitEdge(type: string): boolean {
  if (type === 'group') return false;
  if (S.doc.kind === 'fsm') return type !== 'init' && type !== 'final';
  return true;
}

/**
 * 把一条连线截成两段，中间塞一个新图形：
 *   A ----→ B   变成   A ----→ N ----→ B
 * 原连线保留 id 与标签（接在 A 侧），新连线继承终点与样式。
 */
function insertOnEdge(edgeId: string, type: string, at?: Pt): string | null {
  const e = S.doc.edges.find((x) => x.id === edgeId);
  if (!e || e.from.node === e.to.node) return null;
  if (!canSplitEdge(type)) {
    addNode(type, at ?? edgeMidPoint(e) ?? undefined);
    return null;
  }

  // 手工布局下按落点摆放；自动布局交给分层算法把新节点插进序列里
  const manual = S.doc.options.layout === 'manual' || S.doc.nodes.every((n) => n.pos);

  snapshot();
  const shape = shapeOf(type, S.doc.kind);
  const mid = at ?? edgeMidPoint(e) ?? { x: 0, y: 0 };
  const id = uniqueNodeId(type);
  const nd: DiagramNode = {
    id,
    type,
    label: shape.cn,
    x: mid.x - shape.w / 2,
    y: mid.y - shape.h / 2,
    w: shape.w,
    h: shape.h,
    ...(manual ? { pos: [Math.round(mid.x - shape.w / 2), Math.round(mid.y - shape.h / 2)] as [number, number] } : {}),
    size: [shape.w, shape.h],
    ports: [],
  };

  const tail: DiagramEdge = {
    ...e,
    id: uniqueEdgeId(),
    from: { node: id },
    to: { ...e.to },
    label: undefined,
    action: undefined,
  };
  e.to = { node: id };

  S.doc.nodes.push(nd);
  S.doc.edges.splice(S.doc.edges.indexOf(e) + 1, 0, tail);
  S.sel = { nodes: [id], edges: [], panel: null, row: null };
  S.posOnly = false;

  // 先让布局排好，再按实际位置把两条箭头钉在新节点的对侧中点，
  // 这样 A→N→B 是"穿过"节点，而不是从角上折进去
  paint();
  const fromNode = S.doc.nodes.find((n) => n.id === e.from.node);
  const toNode = S.doc.nodes.find((n) => n.id === tail.to.node);
  if (fromNode) e.to = { node: id, side: sideFacing(nd, fromNode) };
  if (toNode) tail.from = { node: id, side: sideFacing(nd, toNode) };
  paint();
  paintInspector();
  paintToolbar();
  save();
  return id;
}

/** 默认插入哪种图形 */
function defaultInsertType(): string {
  return S.doc.kind === 'fsm' ? 'state' : 'module';
}

function deleteSelection(): void {
  if (!S.sel.nodes.length && !S.sel.edges.length) return;
  snapshot();
  const nodes = new Set(S.sel.nodes);
  S.doc.nodes = S.doc.nodes.filter((n) => !nodes.has(n.id));
  S.doc.edges = S.doc.edges.filter((e) => !S.sel.edges.includes(e.id) && !nodes.has(e.from.node) && !nodes.has(e.to.node));
  S.sel = { nodes: [], edges: [], panel: S.sel.panel, row: null };
  paint();
  paintInspector();
  paintToolbar();
  save();
}

function duplicateSelection(): void {
  const nodes = S.doc.nodes.filter((n) => S.sel.nodes.includes(n.id));
  if (!nodes.length) return;
  snapshot();
  const map = new Map<string, string>();
  const copies: DiagramNode[] = nodes.map((n) => {
    let id = n.id + '_copy';
    let i = 1;
    while (S.doc.nodes.some((x) => x.id === id)) id = `${n.id}_copy${++i}`;
    map.set(n.id, id);
    return { ...n, id, x: n.x + 24, y: n.y + 24, pos: [n.x + 24, n.y + 24], ports: n.ports.map((p) => ({ ...p })) };
  });
  S.doc.nodes.push(...copies);
  const newEdges = S.doc.edges
    .filter((e) => map.has(e.from.node) && map.has(e.to.node))
    .map((e, i) => ({ ...e, id: `ec${Date.now()}${i}`, from: { ...e.from, node: map.get(e.from.node)! }, to: { ...e.to, node: map.get(e.to.node)! } }));
  S.doc.edges.push(...newEdges);
  S.sel = { nodes: copies.map((c) => c.id), edges: [], panel: null, row: null };
  paint();
  paintInspector();
  save();
}

function alignSelection(how: string): void {
  const nodes = S.doc.nodes.filter((n) => S.sel.nodes.includes(n.id));
  if (nodes.length < 2) return;
  snapshot();
  const minX = Math.min(...nodes.map((n) => n.x));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  for (const n of nodes) {
    if (how === 'left') n.pos = [minX, n.y];
    if (how === 'right') n.pos = [maxX - n.w, n.y];
    if (how === 'hcenter') n.pos = [(minX + maxX) / 2 - n.w / 2, n.y];
    if (how === 'top') n.pos = [n.x, minY];
    if (how === 'bottom') n.pos = [n.x, maxY - n.h];
    if (how === 'vcenter') n.pos = [n.x, (minY + maxY) / 2 - n.h / 2];
    if (n.pos) n.pos = [Math.round(n.pos[0]), Math.round(n.pos[1])];
  }
  paint();
  savePos();
}

function setPanelSteps(panel: TimingPanel, steps: number): void {
  panel.steps = Math.max(4, Math.min(512, Math.round(steps)));
  for (const r of panel.rows) {
    while (r.values.length < panel.steps) r.values.push('');
    r.values.length = panel.steps;
  }
}

function panelRows(): TimingRow[] {
  return curPanel()?.rows ?? [];
}

function addTimingRow(type: 'clock' | 'logic' | 'bus' | 'group'): void {
  const panel = curPanel();
  if (!panel) return;
  snapshot();
  const base = type === 'clock' ? 'clk' : type === 'bus' ? 'data' : type === 'group' ? '分组' : 'sig';
  let name = base;
  let i = 1;
  while (panel.rows.some((r) => r.name === name)) name = `${base}${++i}`;
  panel.rows.push({
    name,
    type,
    period: type === 'clock' ? 2 : undefined,
    freq: type === 'clock' ? 100 : undefined,
    duty: type === 'clock' ? 0.5 : undefined,
    phase: type === 'clock' ? 0 : undefined,
    values: type === 'clock' || type === 'group' ? [] : new Array(panel.steps).fill(type === 'bus' ? '' : '0'),
  });
  if (type === 'clock') syncClockFreqs(S.doc);
  S.sel = { nodes: [], edges: [], panel: S.activePanel, row: panel.rows.length - 1 };
  paint();
  paintTimingPalette();
  paintInspector();
  save();
}

function moveRow(i: number, delta: number): void {
  const panel = curPanel();
  if (!panel) return;
  const j = i + delta;
  if (j < 0 || j >= panel.rows.length) return;
  snapshot();
  const [row] = panel.rows.splice(i, 1);
  panel.rows.splice(j, 0, row);
  S.sel.panel = S.activePanel;
  S.sel.row = j;
  paint();
  paintTimingPalette();
  paintInspector();
  save();
}

function resizeSteps(delta: number): void {
  const panel = curPanel();
  if (!panel) return;
  snapshot();
  setPanelSteps(panel, panel.steps + delta);
  paint();
  paintTimingPalette();
  save();
}

function addTimingPanel(): void {
  snapshot();
  const steps = curPanel()?.steps ?? 16;
  const panel = starterTimingPanel(steps);
  panel.title = `时序组 ${S.doc.panels.length + 1}`;
  S.doc.panels.push(panel);
  S.activePanel = S.doc.panels.length - 1;
  S.sel = { nodes: [], edges: [], panel: S.activePanel, row: null };
  paint();
  paintTimingPalette();
  paintInspector();
  save();
}

function deleteTimingPanel(i: number): void {
  if (S.doc.panels.length <= 1) return;
  snapshot();
  S.doc.panels.splice(i, 1);
  S.activePanel = Math.min(S.activePanel, S.doc.panels.length - 1);
  if (i < S.activePanel) S.activePanel -= 1;
  S.sel = { nodes: [], edges: [], panel: S.activePanel, row: null };
  paint();
  paintTimingPalette();
  paintInspector();
  save();
}

function renamePanel(i: number): void {
  const panel = S.doc.panels[i];
  if (!panel) return;
  const node = paletteEl.querySelectorAll('.panel-item')[i] as HTMLElement | undefined;
  const r = node?.getBoundingClientRect();
  editInlineFixed(r ? r.left : 20, r ? r.top : 120, r ? Math.max(100, r.width) : 140, panel.title ?? '', (v) => {
    snapshot();
    panel.title = v.trim() || undefined;
    paint();
    paintTimingPalette();
    save();
  });
}

// ------------------------------------------------------------------ inline editing

function editInline(sx: number, sy: number, width: number, value: string, multiline: boolean, commit: (v: string) => void): void {
  closeInline();
  const input = document.createElement(multiline ? 'textarea' : 'input') as HTMLInputElement | HTMLTextAreaElement;
  input.className = 'inline-edit';
  input.value = value;
  input.style.left = Math.max(0, sx) + 'px';
  input.style.top = Math.max(0, sy) + 'px';
  input.style.width = Math.max(70, width) + 'px';
  overlay.appendChild(input);
  input.focus();
  input.select();
  let finished = false;
  const done = (apply: boolean) => {
    if (finished) return;
    finished = true;
    const v = input.value;
    detach(input);
    if (apply) commit(v);
  };
  input.addEventListener('keydown', (evt) => {
    const ev = evt as KeyboardEvent;
    ev.stopPropagation();
    if (ev.key === 'Enter' && !multiline) done(true);
    if (ev.key === 'Enter' && multiline && (ev.ctrlKey || ev.metaKey)) done(true);
    if (ev.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
}

function detach(n: Element): void {
  try {
    if (n.parentNode) n.parentNode.removeChild(n);
  } catch {
    /* 已被 blur 处理移除 */
  }
}

/** 页签/面板名这类不在画布里的重命名：用 fixed 定位的输入框 */
function editInlineFixed(sx: number, sy: number, width: number, value: string, commit: (v: string) => void): void {
  document.querySelectorAll('.inline-edit.fixed').forEach((n) => detach(n));
  const input = document.createElement('input');
  input.className = 'inline-edit fixed';
  input.value = value;
  input.style.left = Math.max(2, sx) + 'px';
  input.style.top = Math.max(2, sy) + 'px';
  input.style.width = Math.max(90, width) + 'px';
  document.body.appendChild(input);
  input.focus();
  input.select();
  let finished = false;
  const done = (apply: boolean) => {
    if (finished) return;
    finished = true;
    const v = input.value;
    detach(input);
    if (apply) commit(v);
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') done(true);
    if (ev.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
}

function closeInline(): void {
  overlay.querySelectorAll('.inline-edit').forEach((n) => detach(n));
}

// ------------------------------------------------------------------ interactions

let spaceDown = false;
let marquee: SVGRectElement | null = null;
let tempLine: SVGLineElement | null = null;
let paletteDragged = false;

// --------------------------------------------------- 从调色板拖到连线中间

// --------------------------------------------------- 从调色板拖到连线中间

function edgeGroupOf(id: string): Element | null {
  for (const el of Array.from(canvas.querySelectorAll('[data-edge]'))) {
    if (el.getAttribute('data-edge') !== id) continue;
    return el.tagName.toLowerCase() === 'g' ? el : el.parentElement;
  }
  return null;
}

/** 高亮/取消高亮"当前悬停的连线"，让用户看清会插到哪里 */
function highlightEdge(id: string | null): void {
  if (S.dropEdge === id) return;
  S.dropEdge = id;
  paint();
}

function startPaletteDrag(ev: PointerEvent, type: string): void {
  if (ev.button !== 0 || S.doc.kind === 'timing') return;
  const sx = ev.clientX;
  const sy = ev.clientY;
  let ghost: HTMLDivElement | null = null;
  let moved = false;

  const move = (e: PointerEvent) => {
    if (!moved) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
      moved = true;
      ghost = el('div', 'drag-ghost');
      ghost.innerHTML = previewOf(type);
      document.body.appendChild(ghost);
      S.drag = { mode: 'palette' };
    }
    if (ghost) {
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
    }
    const over = document.elementFromPoint(e.clientX, e.clientY);
    highlightEdge(over?.closest?.('[data-edge]')?.getAttribute('data-edge') ?? null);
  };

  const up = (e: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (!moved) return; // 没拖动：交给 click 走"添加到画布中心"

    paletteDragged = true;
    window.setTimeout(() => {
      paletteDragged = false;
    }, 400);

    const target = document.elementFromPoint(e.clientX, e.clientY);
    const edgeId = target?.closest?.('[data-edge]')?.getAttribute('data-edge') ?? null;
    detach(ghost!);
    ghost = null;
    highlightEdge(null);
    S.drag = null;

    const u = toUser(e);
    if (edgeId) insertOnEdge(edgeId, type, u);
    else if (target && stage.contains(target)) addNode(type, u);
    else addNode(type);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// --------------------------------------------------- 连线右键菜单

let openMenu: HTMLElement | null = null;

function onMenuOutside(ev: PointerEvent): void {
  if (openMenu && openMenu.contains(ev.target as Node)) return;
  closeMenu();
}

function onMenuKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') closeMenu();
}

function closeMenu(): void {
  if (openMenu) {
    detach(openMenu);
    openMenu = null;
  }
  window.removeEventListener('pointerdown', onMenuOutside, true);
  window.removeEventListener('keydown', onMenuKey, true);
}

function editEdgeLabel(edgeId: string, clientX: number, clientY: number): void {
  const e = S.doc.edges.find((ed) => ed.id === edgeId);
  if (!e) return;
  const r = stage.getBoundingClientRect();
  editInline(clientX - r.left - 40, clientY - r.top - 10, 100, e.label ?? '', false, (v) => {
    snapshot();
    e.label = v.trim() || undefined;
    S.posOnly = false;
    paint();
    save();
  });
}

/** 通用小菜单：页签「＋」、添加信号之类的短选项 */
function openPopup(x: number, y: number, items: [string, () => void][]): void {
  closeMenu();
  const menu = el('div', 'edge-menu');
  for (const [text, fn] of items) {
    const b = el('button', '', text);
    b.addEventListener('click', () => {
      closeMenu();
      fn();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const box = menu.getBoundingClientRect();
  if (box.right > window.innerWidth - 6) menu.style.left = `${Math.max(6, window.innerWidth - box.width - 6)}px`;
  if (box.bottom > window.innerHeight - 6) menu.style.top = `${Math.max(6, window.innerHeight - box.height - 6)}px`;
  openMenu = menu;
  window.setTimeout(() => {
    window.addEventListener('pointerdown', onMenuOutside, true);
    window.addEventListener('keydown', onMenuKey, true);
  }, 0);
}

function openEdgeMenu(x: number, y: number, edgeId: string): void {
  closeMenu();
  if (!S.doc.edges.some((e) => e.id === edgeId)) return;
  const menu = el('div', 'edge-menu');
  const addItem = (text: string, fn: () => void) => {
    const b = el('button', '', text);
    b.addEventListener('click', () => {
      closeMenu();
      fn();
    });
    menu.appendChild(b);
  };
  const noun = S.doc.kind === 'fsm' ? '状态' : '模块';
  addItem(`在中间插入${noun}`, () => insertOnEdge(edgeId, defaultInsertType()));
  addItem('编辑标签', () => editEdgeLabel(edgeId, x, y));
  menu.appendChild(el('div', 'sep'));
  addItem('删除连线', () => {
    S.sel = { nodes: [], edges: [edgeId], panel: null, row: null };
    deleteSelection();
  });
  document.body.appendChild(menu);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const box = menu.getBoundingClientRect();
  if (box.right > window.innerWidth - 6) menu.style.left = `${Math.max(6, window.innerWidth - box.width - 6)}px`;
  if (box.bottom > window.innerHeight - 6) menu.style.top = `${Math.max(6, window.innerHeight - box.height - 6)}px`;
  openMenu = menu;
  window.setTimeout(() => {
    window.addEventListener('pointerdown', onMenuOutside, true);
    window.addEventListener('keydown', onMenuKey, true);
  }, 0);
}

stage.addEventListener('pointerdown', (ev: PointerEvent) => {
  if (ev.button === 1 || (ev.button === 0 && spaceDown)) {
    S.drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, vx: S.view.x, vy: S.view.y };
    stage.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    return;
  }
  if (ev.button !== 0) return;
  const target = ev.target as Element;
  const u = toUser(ev);
  closeInline();

  const handleEl = target.closest('[data-handle]');
  const nd0 = selNode();
  if (handleEl && nd0) {
    snapshot();
    S.drag = { mode: 'resize', dir: handleEl.getAttribute('data-handle'), start: u, node: nd0, rect: { x: nd0.x, y: nd0.y, w: nd0.w, h: nd0.h } };
    (stage as HTMLElement).setPointerCapture(ev.pointerId);
    ev.preventDefault();
    return;
  }

  const anchorEl = target.closest('[data-anchor]');
  if (anchorEl) {
    const [nodeId, side, port] = String(anchorEl.getAttribute('data-anchor')).split(':');
    const from = byId(nodeId);
    if (from) {
      S.drag = { mode: 'connect', fromNode: nodeId, side: side as Side, port, start: u };
      tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tempLine.setAttribute('stroke', P.accent);
      tempLine.setAttribute('stroke-width', '1.6');
      tempLine.setAttribute('stroke-dasharray', '5 4');
      tempLine.setAttribute('pointer-events', 'none');
      canvas.appendChild(tempLine);
      ev.preventDefault();
      return;
    }
  }

  const nodeEl = target.closest('[data-node]');
  if (nodeEl) {
    const id = nodeEl.getAttribute('data-node')!;
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (!S.sel.nodes.includes(id)) {
      S.sel.nodes = additive ? [...S.sel.nodes, id] : [id];
      S.sel.edges = [];
      S.sel.row = null;
    } else if (additive) {
      S.sel.nodes = S.sel.nodes.filter((x) => x !== id);
    }
    paint();
    paintInspector();
    const nodes = S.doc.nodes.filter((n) => S.sel.nodes.includes(n.id));
    if (!nodes.some((n) => n.id === id) && !additive) return;
    snapshot();
    S.drag = {
      mode: 'move',
      start: u,
      items: nodes.map((n) => ({ node: n, x: n.pos?.[0] ?? n.x, y: n.pos?.[1] ?? n.y })),
    };
    ev.preventDefault();
    return;
  }

  const edgeEl = target.closest('[data-edge]');
  if (edgeEl) {
    S.sel = { nodes: [], edges: [edgeEl.getAttribute('data-edge')!], panel: null, row: null };
    paint();
    paintInspector();
    return;
  }

  const cell = target.closest('[data-cell]');
  if (cell && S.doc.kind === 'timing') {
    const [pi, ri, ci] = String(cell.getAttribute('data-cell')).split(':').map(Number);
    const panel = S.doc.panels[pi];
    const row = panel?.rows[ri];
    if (row && row.type !== 'group' && row.type !== 'clock') {
      S.activePanel = pi;
      S.sel = { nodes: [], edges: [], panel: pi, row: ri };
      if (row.type === 'bus') {
        if (S.brush === 'value') openBusValueEdit(pi, ri, ci, ev.clientX, ev.clientY);
        else if (S.brush === 'z') {
          snapshot();
          row.values[ci] = 'z';
          paint();
          paintTimingPalette();
          paintInspector();
          save();
        } else {
          flash('总线请用「值…」笔刷改值，Z 笔刷用来断开');
        }
        return;
      }
      snapshot();
      const value = nextCellValue(row, ci);
      S.drag = { mode: 'paint', panel: pi, row: ri, paintValue: value };
      applyCell(pi, ri, ci, value);
      paint();
      paintTimingPalette();
    }
    return;
  }

  const rowName = target.closest('[data-rowname]');
  if (rowName) {
    const [pi, ri] = String(rowName.getAttribute('data-rowname')).split(':').map(Number);
    S.activePanel = pi;
    S.sel = { nodes: [], edges: [], panel: pi, row: ri };
    paint();
    paintTimingPalette();
    paintInspector();
    return;
  }

  // 背景框选
  if (!ev.shiftKey) {
    S.sel = { nodes: [], edges: [], panel: S.sel.panel, row: null };
    paint();
    paintInspector();
  }
  const r = stage.getBoundingClientRect();
  marquee = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  marquee.setAttribute('fill', P.accent);
  marquee.setAttribute('fill-opacity', '0.08');
  marquee.setAttribute('stroke', P.accent);
  marquee.setAttribute('stroke-width', '1');
  marquee.setAttribute('stroke-dasharray', '4 3');
  canvas.appendChild(marquee);
  S.drag = { mode: 'marquee', start: u, screen: { x: ev.clientX - r.left, y: ev.clientY - r.top }, shift: ev.shiftKey };
});

window.addEventListener('pointermove', (ev: PointerEvent) => {
  const u = toUser(ev);
  const d = S.drag;

  if (!d) {
    if (S.doc.kind !== 'timing' && ev.target instanceof Element && stage.contains(ev.target)) {
      const target = ev.target;
      const nodeEl = target.closest?.('[data-node]');
      const id = nodeEl ? nodeEl.getAttribute('data-node') : null;
      if (id !== S.hover) {
        S.hover = id;
        paint();
      }
    }
    return;
  }

  if (d.mode === 'pan') {
    S.view.x = d.vx - (ev.clientX - d.sx) / S.view.k;
    S.view.y = d.vy - (ev.clientY - d.sy) / S.view.k;
    applyView();
    return;
  }

  if (d.mode === 'move') {
    let dx = u.x - d.start.x;
    let dy = u.y - d.start.y;
    for (const item of d.items) {
      let nx = item.x + dx;
      let ny = item.y + dy;
      if (S.snap) {
        nx = Math.round(nx / 5) * 5;
        ny = Math.round(ny / 5) * 5;
      }
      item.node.pos = [nx, ny];
    }
    paint();
    return;
  }

  if (d.mode === 'resize') {
    const nd = d.node as DiagramNode;
    const dx = u.x - d.start.x;
    const dy = u.y - d.start.y;
    const r0 = d.rect as { x: number; y: number; w: number; h: number };
    let { x, y, w, h } = r0;
    const dir = String(d.dir);
    if (dir.includes('w')) {
      w = Math.max(26, r0.w - dx);
      x = r0.x + (r0.w - w);
    }
    if (dir.includes('e')) w = Math.max(26, r0.w + dx);
    if (dir.includes('n')) {
      h = Math.max(22, r0.h - dy);
      y = r0.y + (r0.h - h);
    }
    if (dir.includes('s')) h = Math.max(22, r0.h + dy);
    if (S.snap) {
      x = Math.round(x / 5) * 5;
      y = Math.round(y / 5) * 5;
      w = Math.round(w / 5) * 5;
      h = Math.round(h / 5) * 5;
    }
    nd.w = w;
    nd.h = h;
    nd.size = [w, h];
    nd.pos = [x, y];
    paint();
    return;
  }

  if (d.mode === 'connect' && tempLine) {
    const from = byId(d.fromNode);
    if (!from) return;
    const a = portAnchor(from, d.side as Side, d.port);
    tempLine.setAttribute('x1', String(a.x));
    tempLine.setAttribute('y1', String(a.y));
    tempLine.setAttribute('x2', String(u.x));
    tempLine.setAttribute('y2', String(u.y));
    return;
  }

  if (d.mode === 'marquee' && marquee) {
    const r = stage.getBoundingClientRect();
    const sx = d.screen.x;
    const sy = d.screen.y;
    const cx = ev.clientX - r.left;
    const cy = ev.clientY - r.top;
    const x1 = Math.min(sx, cx) / S.view.k + S.view.x;
    const y1 = Math.min(sy, cy) / S.view.k + S.view.y;
    const x2 = Math.max(sx, cx) / S.view.k + S.view.x;
    const y2 = Math.max(sy, cy) / S.view.k + S.view.y;
    marquee.setAttribute('x', String(x1));
    marquee.setAttribute('y', String(y1));
    marquee.setAttribute('width', String(x2 - x1));
    marquee.setAttribute('height', String(y2 - y1));
    const hit = S.doc.nodes.filter((n) => n.x < x2 && n.x + n.w > x1 && n.y < y2 && n.y + n.h > y1).map((n) => n.id);
    S.sel.nodes = d.shift ? [...new Set([...S.sel.nodes, ...hit])] : hit;
    return;
  }

  if (d.mode === 'paint') {
    const target = ev.target as Element;
    const cell = target.closest?.('[data-cell]');
    if (!cell) return;
    const [pi, ri, ci] = String(cell.getAttribute('data-cell')).split(':').map(Number);
    if (pi !== d.panel || ri !== d.row) return;
    applyCell(pi, ri, ci, d.paintValue);
    paint();
  }
});

window.addEventListener('pointerup', (ev: PointerEvent) => {
  const d = S.drag;
  S.drag = null;
  if (tempLine) {
    tempLine.remove();
    tempLine = null;
  }
  if (marquee) {
    marquee.remove();
    marquee = null;
    paint();
    paintToolbar();
    return;
  }
  if (!d) return;

  if (d.mode === 'connect') {
    const dropped = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-node]');
    const toId = dropped?.getAttribute('data-node');
    if (toId) {
      snapshot();
      const exists = S.doc.edges.some((e) => e.from.node === d.fromNode && e.to.node === toId);
      if (!exists) {
        S.doc.edges.push({
          id: `e${Date.now().toString(36)}`,
          from: { node: d.fromNode, port: d.port },
          to: { node: toId },
          style: S.doc.kind === 'fsm' ? 'wire' : 'wire',
          route: 'orth',
          arrow: 'end',
        });
        S.sel = { nodes: [], edges: [], panel: S.sel.panel, row: null };
      }
      S.posOnly = false;
      paint();
      paintInspector();
      save();
    }
    return;
  }

  if (d.mode === 'move' || d.mode === 'resize') {
    paintInspector();
    paintToolbar();
    savePos();
    return;
  }

  if (d.mode === 'paint') {
    paintInspector();
    save();
  }
});

stage.addEventListener('contextmenu', (ev: MouseEvent) => {
  const target = ev.target as Element;
  const edgeEl = target.closest?.('[data-edge]');
  if (!edgeEl) return;
  ev.preventDefault();
  const id = edgeEl.getAttribute('data-edge');
  if (id) openEdgeMenu(ev.clientX, ev.clientY, id);
});

stage.addEventListener('dblclick', (ev: MouseEvent) => {
  const target = ev.target as Element;
  const nodeEl = target.closest('[data-node]');
  const edgeEl = target.closest('[data-edge]');
  const rowName = target.closest('[data-rowname]');
  const cell = target.closest('[data-cell]');

  if (rowName && S.doc.kind === 'timing') {
    const [pi, ri] = String(rowName.getAttribute('data-rowname')).split(':').map(Number);
    const row = S.doc.panels[pi]?.rows[ri];
    if (!row) return;
    const r = stage.getBoundingClientRect();
    editInline(ev.clientX - r.left - 40, ev.clientY - r.top - 10, 130, row.name, false, (v) => {
      if (v.trim()) row.name = v.trim();
      paint();
      paintTimingPalette();
      save();
    });
    return;
  }

  if (cell && S.doc.kind === 'timing') {
    const [pi, ri, ci] = String(cell.getAttribute('data-cell')).split(':').map(Number);
    const row = S.doc.panels[pi]?.rows[ri];
    if (!row || (row.type !== 'bus' && row.type !== 'logic')) return;
    openBusValueEdit(pi, ri, ci, ev.clientX, ev.clientY);
    return;
  }

  if (nodeEl) {
    const nd = byId(nodeEl.getAttribute('data-node')!);
    if (!nd) return;
    if (nd.type === 'init' || nd.type === 'final' || nd.type === 'junction') return;
    const box = toScreen({ x: nd.x, y: nd.y });
    editInline(box.x, box.y + (nd.h * S.view.k) / 2 - 12, nd.w * S.view.k, nd.label, nd.type === 'note', (v) => {
      snapshot();
      nd.label = v;
      S.posOnly = false;
      paint();
      save();
    });
    return;
  }

  if (edgeEl) {
    const e = S.doc.edges.find((x) => x.id === edgeEl.getAttribute('data-edge'));
    if (!e) return;
    const r = stage.getBoundingClientRect();
    editInline(ev.clientX - r.left - 40, ev.clientY - r.top - 10, 100, e.label ?? '', false, (v) => {
      snapshot();
      e.label = v.trim() || undefined;
      S.posOnly = false;
      paint();
      save();
    });
  }
});

stage.addEventListener(
  'wheel',
  (ev: WheelEvent) => {
    ev.preventDefault();
    const u = toUser(ev);
    const r = stage.getBoundingClientRect();
    const factor = Math.exp(-ev.deltaY * 0.0016);
    const k = Math.min(4, Math.max(0.2, S.view.k * factor));
    S.view.k = k;
    S.view.x = u.x - (ev.clientX - r.left) / k;
    S.view.y = u.y - (ev.clientY - r.top) / k;
    applyView();
  },
  { passive: false },
);

function anchorOf(nd: DiagramNode, side: Side): Pt {
  switch (side) {
    case 'l':
      return { x: nd.x, y: nd.y + nd.h / 2 };
    case 'r':
      return { x: nd.x + nd.w, y: nd.y + nd.h / 2 };
    case 't':
      return { x: nd.x + nd.w / 2, y: nd.y };
    default:
      return { x: nd.x + nd.w / 2, y: nd.y + nd.h };
  }
}

function nextCellValue(row: { type: string; values: string[] }, ci: number): string {
  const cur = effectiveValues(row as any, ci + 1)[ci] || '0';
  if (S.brush === 'toggle') return cur === '1' ? '0' : '1';
  return S.brush === 'value' ? cur : S.brush;
}

function applyCell(pi: number, ri: number, ci: number, value: string): void {
  const row = S.doc.panels[pi]?.rows[ri];
  if (!row || row.type === 'group' || row.type === 'clock') return;
  row.values[ci] = value;
}

/** 总线/单比特改值：画布上就近弹出输入框 */
function openBusValueEdit(pi: number, ri: number, ci: number, clientX: number, clientY: number): void {
  const panel = S.doc.panels[pi];
  const row = panel?.rows[ri];
  if (!panel || !row) return;
  const cur = effectiveValues(row, panel.steps)[ci] ?? '';
  const r = stage.getBoundingClientRect();
  editInline(clientX - r.left - 24, clientY - r.top - 10, 96, cur, false, (v) => {
    snapshot();
    row.values[ci] = v.trim();
    S.posOnly = false;
    paint();
    paintTimingPalette();
    paintInspector();
    save();
  });
}

let flashTimer = 0;
function flash(msg: string): void {
  statusEl.innerHTML = `<span class="warn">${esc(msg)}</span>`;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => paintStatus(), 2200);
}

// ------------------------------------------------------------------ keyboard

window.addEventListener('keydown', (ev: KeyboardEvent) => {
  const tag = (document.activeElement?.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (ev.code === 'Space') {
    spaceDown = true;
    stage.style.cursor = 'grab';
  }
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && ev.key.toLowerCase() === 'y') {
    ev.preventDefault();
    redo();
    return;
  }
  if (mod && ev.key.toLowerCase() === 'd') {
    ev.preventDefault();
    duplicateSelection();
    return;
  }
  if (mod && ev.key.toLowerCase() === 'a') {
    ev.preventDefault();
    S.sel.nodes = S.doc.nodes.map((n) => n.id);
    paint();
    paintInspector();
    paintToolbar();
    return;
  }
  if (mod && ev.key === '0') {
    ev.preventDefault();
    fitView();
    return;
  }
  if (ev.key === 'Enter' && S.sel.edges.length === 1) {
    ev.preventDefault();
    insertOnEdge(S.sel.edges[0], defaultInsertType());
    return;
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    if (S.doc.kind === 'timing' && S.sel.row !== null) {
      const panel = S.doc.panels[S.sel.panel ?? S.activePanel];
      if (panel) {
        snapshot();
        panel.rows.splice(S.sel.row, 1);
        S.sel.row = null;
        paint();
        paintTimingPalette();
        paintInspector();
        save();
      }
      return;
    }
    deleteSelection();
    return;
  }
  if (ev.key === 'Escape') {
    S.sel = { nodes: [], edges: [], panel: S.sel.panel, row: null };
    paint();
    paintInspector();
    return;
  }
  const nudge: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  if (nudge[ev.key] && S.sel.nodes.length) {
    ev.preventDefault();
    const step = ev.shiftKey ? 10 : 1;
    const [dx, dy] = nudge[ev.key];
    for (const n of S.doc.nodes.filter((x) => S.sel.nodes.includes(x.id))) {
      const px = n.pos?.[0] ?? n.x;
      const py = n.pos?.[1] ?? n.y;
      n.pos = [px + dx * step, py + dy * step];
    }
    paint();
    savePos();
  }
});

window.addEventListener('keyup', (ev: KeyboardEvent) => {
  if (ev.code === 'Space') {
    spaceDown = false;
    stage.style.cursor = '';
  }
});

// ------------------------------------------------------------------ export

function buildSvg(): { svg: string; w: number; h: number } {
  const res = render(S.doc, { theme: P, padding: 28 });
  const svg = svgDocument(res.body, res.width, res.height, P, S.doc.title);
  return { svg, w: res.width, h: res.height };
}

function suggestedName(ext: string): string {
  const base = (S.doc.title || S.doc.kind).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 48) || 'diagram';
  return base + ext;
}

function exportSvg(): void {
  const { svg } = buildSvg();
  vscode.postMessage({ type: 'export', format: 'svg', text: svg, name: suggestedName('.svg') });
}

function exportPng(): void {
  const { svg, w, h } = buildSvg();
  const img = new Image();
  const scale = 2;
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * scale);
    c.height = Math.ceil(h * scale);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const base64 = c.toDataURL('image/png').split(',')[1];
    vscode.postMessage({ type: 'export', format: 'png', base64, name: suggestedName('.png') });
  };
  img.onerror = () => vscode.postMessage({ type: 'error', message: 'PNG 导出失败，可改用 SVG 导出' });
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function fitView(): void {
  const r = stage.getBoundingClientRect();
  const w = Math.max(1, S.res.w);
  const h = Math.max(1, S.res.h);
  const k = Math.min(1.6, Math.max(0.2, Math.min((r.width - 40) / w, (r.height - 40) / h)));
  S.view.k = k;
  S.view.x = -((r.width / k - w) / 2);
  S.view.y = -((r.height / k - h) / 2);
  applyView();
}

// ------------------------------------------------------------------ host sync

function applyFileText(text: string, external: boolean): void {
  S.fileText = text;
  const { file, diagnostics } = parseFile(text, S.kind);
  S.scenes = file.scenes;
  S.active = file.active;
  S.doc = S.scenes[S.active];
  S.diags = diagnostics;
  S.kind = S.doc.kind;
  S.activePanel = 0;
  if (external) {
    S.sel = { nodes: [], edges: [], panel: S.sel.panel, row: null };
    S.history.length = 0;
    S.future.length = 0;
  }
  paint();
  paintTabs();
  paintToolbar();
  paintPalette();
  paintInspector();
  if (external) setTimeout(fitView, 20);
}

window.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'update') {
    const text = String(msg.text ?? '');
    if (text === S.lastPosted) return;
    if (text === S.fileText && S.ready) return;
    applyFileText(text, true);
  } else if (msg.type === 'command') {
    if (msg.name === 'exportSvg') exportSvg();
    if (msg.name === 'exportPng') exportPng();
    if (msg.name === 'fit') fitView();
    if (msg.name === 'undo') undo();
    if (msg.name === 'redo') redo();
  } else if (msg.type === 'theme') {
    refreshTheme();
  }
});

function refreshTheme(): void {
  P = palette(detectTheme());
  paintGrid();
  paint();
  paintPalette();
  paintInspector();
}

new MutationObserver(() => refreshTheme()).observe(document.body, { attributes: true, attributeFilter: ['class'] });

const ro = new ResizeObserver(() => applyView());
ro.observe(stage);

// ------------------------------------------------------------------ boot

function boot(): void {
  P = palette(detectTheme());
  paintGrid();
  paintTabs();
  paintToolbar();
  paintPalette();
  paintInspector();
  vscode.postMessage({ type: 'ready' });
  S.ready = true;
}

boot();

// 供调试
(window as any).__fd = { S, paint, render, serializeFile, parseFile, insertOnEdge, addScene, switchScene };
