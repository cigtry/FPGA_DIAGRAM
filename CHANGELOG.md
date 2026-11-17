# Changelog

## 2.0.1

- 移除「框图 / 原理图」两个可新建类型；视图类型、新增页签、命令面板、示例与 MCP 只保留系统框图 / 状态机 / 时序图。旧 `.fpgad` 文件仍能正常打开和编辑。
- 修复右侧属性面板输入到一半失焦的问题：自身保存回写不再被当成外部更新，输入期间不重建属性面板、不抢焦点、不自动缩放视图。
- 层次框的上/下边端口现在会正常绘制；新增端口可选 input / output / inout，按方向默认落到左 / 右，改方向或换边会自动归位。
- 层次框和分组选中后四角可直接拖动缩放；左侧组件可拖到画布指定位置，也可拖到连线上插入。
- 工具栏新增「跟随 / 白底 / 黑底」画布背景切换，「网格线」开关独立于 VS Code 主题并记住上次选择；导出 SVG 的背景与所选画布一致。
- 无类型声明的新文件默认按系统框图（`system_block`）打开，不再落到旧 `block`。
- 新增节点与工具栏缩放统一以画布视口中心为基准；按住鼠标右键可直接拖动画布，未拖动时仍保留右键菜单。
- 画布中心新增十字准星标记，标出缩放与新增节点的基准点；工具栏「中心点」可开关，选择会记住，且不会出现在导出的 SVG / PNG 里。

## 2.0.0

按 v2.0 设计稿做**架构级重构**：引入文档模型、命令模式、布局策略与增量渲染，
同时完整保留 0.2.x 已验证的能力（多视图、多时钟、AXI 信号组、Problems 诊断、语法高亮）。
旧 `.fpgad` 文件不写 `version` 就走 v1 格式，存盘不会被迫升级。

### 数据模型（v2）

- 新增 `FPGADocument` 文档头：`version` / `meta`（title/author/created/modified）/ `options`（grid/gridSize/snapToGrid/fontFamily/fontSize）
- `Scene` 增加 `id` 与 `layout` 对象（`strategy` / `direction` / `nodeSpacing` / `layerSpacing`）
- 节点：新增 `style`（fill/stroke/strokeWidth/textColor/dashed）、`collapsed`、`data`
- 端口：新增 `width`（`[19:0]` 自动提取，也能写 `width: 32`）；方向支持 `input/output/inout`
- 连线：新增 `waypoints` 手工拐点与 `visual` 视觉覆盖（stroke/strokeWidth/dashed/color）
- 时序信号：新增 `width` / `order` / `children`（group 子信号递归）
- 新增 `datapath`（数据通路）类型，组件表与 `schematic` 一致

### DSL 双向兼容

- `parseFile` / `serializeFile` 同时支持 v1 与 v2；只有显式 `version: '2.0'` 才输出 v2 文档头
- v1 单图/多视图文件往返字节级稳定（回归覆盖 7 个示例）

### 架构

- **命令模式**：`CommandStore` 替换原来散落的 `JSON.stringify(snapshot)`，支持连续拖拽合并、批量事务、
  可读的撤销/重做标签；undo/redo 栈有上限且完全可序列化
- **交互状态机**：`InteractionManager` 显式化 IDLE/SELECTING/DRAGGING/LINKING/RESIZING/
  REORDERING/WAYPOINT/PAINTING/PANNING/PALACING，非法转移被拒、光标随状态切换
- **布局策略化**：`auto/layered/circular/grid/manual/sugiyama/force`，方向支持 `LR/TB/RL/BT`
- **增量渲染**：`RenderCache` 按内容签名缓存 SVG，内容未变时跳过 layout + 渲染

### 交互

- 拐点编辑：选中直线或带拐点的连线，点中点黄色圆点插入拐点，拖白色圆点调整，右键删除；属性面板可清除全部拐点
- 时序信号拖拽重排：左侧信号列表可直接拖拽上下移动（保留原「上移/下移」按钮）
- 新连线默认直线（0.2.x 已引入）在 v2 中继续生效，旧图纸不受影响

### 质量

- 单元测试从 36 → 67：新增 v2 解析/序列化往返、CommandStore、交互状态机、布局策略、waypoints 渲染、RenderCache
- 无头交互回归累计 67 项全 PASS（主回归 28 / undo 8 / 系统框图 18 / 错误保护 13）

## 0.2.1

### 修复

- **位宽端口能连线了**：`cpu.awaddr[19:0] -> ddr.awaddr[19:0]` 以前会把整串当节点名、报"节点不存在"，
  现在端点正则放行 `[ ] : ( )`；连线标签分隔符也只在括号外生效，`[19:0]` 里的冒号不再被当成标签起点
- **时序信号 `color` 生效**：以前只解析不渲染（写了等于没写），现在时钟/单比特/总线波形都用它上色，
  右侧属性面板也加了「颜色」输入框；色值做白名单校验，带引号/尖括号的值直接拒掉
- **连线标签不再吃掉信号名**：`a -> b : clk 32bit` 以前会把 `clk` 当样式吞掉、标签只剩 `32bit`。
  现在裸样式词只在"标签整串就一个词"时生效（`a -> b : 总线` 照旧），并新增 `style:bus` / `route:curve` 显式写法
- **`-->` 箭头**：正则顺序导致 `-->` 一直被 `--` 抢先匹配成"无箭头"，已修
- **解析出错不再白屏**：语法坏掉时保留上一版画面，画布上方弹出带真实行号的红色横幅，改对后自动消失
- **诊断行号指错**：`lineIndex` 原用子串反查，重复 id、第二条连线全报成文件里第一处。改为按缩进扫描建索引、
  按出现顺序消耗，重复 id 报到第二处、坏连线报到自己那一行
- `mcp` 的 `serverInfo.version` 写死 0.1.0（现读 package.json）；README 里的 vsix 名还停在 0.1.0
- `keywords` 去掉重复的 `waveform` 与不实的 `drawio`；`.vscodeignore` 不再把示例截图打进 vsix

### 新增

- **回归测试**：`npm test` 用 esbuild + `node --test` 跑 26 个用例（samples 全量解析、序列化往返、
  `patchPositions` 保留注释、位宽端点、颜色校验、行号定位），零新增运行时依赖
- `.github/workflows/ci.yml`：push / PR 自动 tsc + test + build
- **语法高亮**：`syntaxes/fpgad.tmLanguage.json`，键名 / 类型值 / 位宽 / 箭头 / 注释分色；
  `language-configuration.json` 补上 `#region` 折叠标记与更准的缩进规则
- `esbuild.mjs` 增加必需资源校验，`media/editor.html` 那段空转残骸删掉

## 0.2.0

### 多视图：切换不再丢内容

- `.fpgad` 支持 `scenes:`：一个文件装框图 / 状态机 / 多组时序，编辑器顶部用**页签**切换
- 「框图 / 状态机 / 时序」不再是"转换类型"，而是跳到同类型视图；没有就新建一个，原视图原封不动
- 页签可双击改名、`×` 删除；历史记录（Ctrl+Z）覆盖所有视图
- 旧单图文件继续可用；单视图文件拖动仍只回写 `pos`，注释不丢

### 时序图

- **多组时序**：`panels:` 在同一画布纵向排列，每组有自己的拍数与时间轴（写通道 / 读通道 / 复位…）
- **多时钟**：时钟行写 `freq: 100`（MHz），时间基准 `tick`（ns/拍）自动细化到最快时钟的半周期，
  100MHz 与 50MHz 叠在一张图上不再错位；时间轴按 ns 标注
- **总线规则明确**：值从所在拍开始保持到下一段，段边界永远落在格线上（1 格 = 1 拍），
  斜切不再是"半拍"的来源；`z` 表示释放（中间虚线）
- **总线可视化编辑**：新增「值…」笔刷，点格子直接输入值；右侧有段编辑器（加段 / 改值 / 挪起点 / 删段）
- **信号可视化编辑**：左侧信号列表（点击选中、双击改名）、「＋ 信号」菜单、时钟频率/占空比/相位在右侧直接改
- 总线/单比特改值不再只能写代码；底部状态栏给出规则提示

### 插入到连线中间

- 拖图形到连线上时，落点取**连线可见折线的中点**，不再用两端锚点的直线中点
- 插入后自动把两条箭头钉在新节点**对侧边的中点**（`side: l/r/t/b`），A→N→B 是穿过去而不是从角上折

### 其它

- 时序示例、README、`docs/DSL.md`、snippet 全部按新语法重写
- CLI `validate` 支持多视图汇总；`render --scene N` 指定渲染第几个视图；`fmt` 保留全部视图
- MCP / VS Code Chat 工具可直接生成多视图与时序组

## 0.1.0

首个版本。

- 三种图表：系统框图（`block`）、状态机（`fsm`）、时序波形（`timing`）
- `.fpgad` 文件：YAML 子集 DSL，坐标自动布局，拖动后只回写 `pos`
- 自定义编辑器：拖拽 / 缩放 / 连线 / 双击改字 / 框选 / 对齐分布 / 撤销重做 / 网格吸附 / 导出 SVG·PNG
- 命令行：`render` `validate` `fmt` `new` `mcp`
- AI 入口：直接写文件、CLI、VS Code Chat 工具 `fpga_draw_diagram`、MCP server
- 缓冲总线段支持 `z` 断开；环形态转移自动转为曲线并分道
