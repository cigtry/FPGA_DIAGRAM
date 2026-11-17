# FPGA Diagram DSL 速查

> 这份文档是给 **AI / 脚本** 看的语法手册。写法刻意宽松：能省的字段都省，
> 你只需要描述"有哪些东西、谁连谁"，坐标由布局器自动计算。

> **2.0.1 起**：编辑器只提供「系统框图 / 状态机 / 时序图」三种可新建类型。`schematic`、`datapath`、
> 旧 `block` 仍可被解析和编辑，仅作为既有文件的兼容格式，不再出现在新建菜单里。

一句话规则：**先写 `diagram_type`（旧文件写 `kind` 也行），再写列表，边用一行 `A -> B : 标签`。**

---

## 0. 六个概念

| 概念 | 字段 | 用途 |
|---|---|---|
| `version` | `'2.0'` | **v2 文档头**（可选）：写了才输出新格式；不写就是 v1，存盘不会被迫升级 |
| `meta` | `title/author/created/modified` | 文档元数据 |
| `options` | `grid/gridSize/snapToGrid/fontFamily/fontSize` | 文档级全局选项 |
| `diagram_type` | `system_block` | **系统框图**：顶层功能模块、接口、层次框（不含底层原语） |
| | `schematic` | **原理图 / 微架构**：寄存器、加法器、乘法器、时钟原语 |
| | `datapath` | **数据通路**：与 `schematic` 同一套组件，强调数据流 |
| `kind`（旧写法） | `block` | 旧格式框图，全组件可见、不做规范告警 |
| | `fsm` | 状态机、协议流程 |
| | `timing` | 时序波形、总线读写时序 |
| **视图** | `scenes:` | 一个 `.fpgad` 里装多张图（页签切换，互不覆盖） |
| **时序组** | `panels:` | 一张时序图里纵向排多组波形，各有时长与时间轴 |

文件扩展名 `.fpgad`。内容可以是 YAML 子集，也兼容 JSON（以 `{` 开头的按 JSON 解析）。

> **v1 与 v2**：只写 `kind` / `diagram_type` 的旧文件是 v1；在文件头加一行 `version: '2.0'` 即升级为 v2，
> 可用 `meta`、`options`、场景 `id`、节点 `style`、连线 `waypoints`、端口 `width` 等新字段。
> 不写 `version` 时，即使读到新字段也不会改变存盘格式——旧图纸永远原样往返。

### 绘图类型分层（向下兼容）

新文件推荐用 `diagram_type` 声明类型，**旧文件只写 `kind` 行为完全不变**：

```yaml
diagram_type: system_block   # 顶层系统框图
# diagram_type: schematic    # 底层原理图 / 微架构
# kind: block                # 旧格式：全组件，不告警
```

| 类型 | 可用组件 | 说明 |
|---|---|---|
| `system_block` | `module` `io` `frame` `group` `note` `diamond` | 符合系统框图规范；写 `reg` / `adder` / `mult` / `mux` / `clock` 会得到 **warning**，但仍照常渲染 |
| `schematic` | 全部 block 组件 | 底层运算、寄存、时钟原语在这里才合规 |
| `block` | 全部 block 组件 | 老图纸兼容，不告警 |

告警形如：`[规范提示] 加法器属于底层原理图组件，不建议在系统框图中使用`，带真实行号，同时出现在编辑器侧栏与 VS Code 的 Problems 面板。

`diagram_type` 也可写在 `scenes:` 的每个视图里，与 `kind` 混用没问题；保存时新类型会原样写回 `diagram_type`。

### 多视图（一个文件装多张图）

编辑器顶部是页签，切换页签不会丢内容——因为它们在同一个文件里：

```yaml
active: 1          # 默认打开第几个视图（从 0 数，省略=0）
scenes:
  - kind: block
    title: 系统框图
    nodes: [...]
  - kind: timing
    title: 写通道时序
    panels: [...]
  - kind: fsm
    title: 控制器状态机
    states: [...]
```

不写 `scenes:` 就是普通单图文件，行为不变。**编辑器里点「＋」或切类型，会自动改写成多视图格式。**

---

## 1. 框图（system_block / schematic / block）

`system_block` 与 `schematic` 是分层后的两种框图，共享同一套节点 / 边语法，只是组件白名单不同。
旧 `block` 有两种版式，行为保持原样：

| 版式 | 写法 | 适合 |
|---|---|---|
| **层次框图**（硬件框图） | `options: {layout: manual}` + `type: frame` + `pos` | 模块里套子模块、信号穿过边界，像数据手册里的框图 |
| **流程图** | 默认 `layout: auto` | 一串处理单元从左到右串起来 |

### 1.1 层次框图（推荐先看这个）

```yaml
kind: block
options:
  layout: manual
nodes:
  - {id: top,  type: frame, label: SoC_WDG, pos: [70, 60], size: [690, 470],
     ports: "l: s_axi_aclk, s_axi_awaddr[19:0]<> | r: wdt_reset, wdt_interrupt"}
  - {id: axi,  type: module, label: AXI4-Lite, sub: Interface, pos: [130, 120], size: [94, 330]}
  - {id: mod,  type: frame, label: Legacy WDT, style: dashed, titlePos: br, pos: [250, 80], size: [420, 210]}
  - {id: reg,  type: module, label: Legacy_reg, pos: [285, 115], size: [120, 66]}
  - {id: ctrl, type: module, label: Legacy_ctrl, pos: [470, 105], size: [130, 100]}
edges:
  - axi <-> reg : straight
  - reg <-> ctrl : straight
```

要点：

- `type: frame` 是**层次框**：外包一层矩形，可无限嵌套；`style: dashed` 画虚线，`titlePos: br` 把标题放到右下角（默认骑在顶边居中）
- 框的 `ports` 会画成**伸出框外的短线 + 箭头**，名字写在框外——这就是"信号穿过模块边界"
- 端口名后缀定方向：`name` 默认（左边进框、右边出框）、`name>` 出框、`name<` 进框、`name<>` 双向
- 边框端口只是标注，不参与连线；要连两个框里的模块，直接用 `A <-> B` 写边
- 子块用 `pos` 手工摆，也可以给 `frame` 写 `children: [id, ...]` 让它自动包住


```yaml
kind: block
title: 视频缩放流水线
nodes:
  - {id: vin,   type: module, label: 视频输入, ports: "l:clk,vs,hs | r:dout"}
  - {id: fifo,  type: fifo,   label: 行缓存,  ports: "l:din | r:dout"}
  - {id: scal,  type: module, label: 双线性缩放}
  - {id: vout,  type: io,     label: 输出}
edges:
  - vin.dout -> fifo.din : "24bit bus"
  - fifo.dout -> scal
  - scal -> vout
```

### 节点字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一标识，连线用它引用。**英文短名最好** |
| `type` | ❌ | 图形类型，缺省 `module`。见下表，中英文都认 |
| `label` | ❌ | 显示文字，缺省等于 `id` |
| `sub` | ❌ | 第二行小字（模块名 / 位宽 / 备注） |
| `ports` | ❌ | 引脚，写法见下 |
| `size` | ❌ | `[宽, 高]`，不写用该图形的默认尺寸 |
| `pos` | ❌ | `[x, y]` 绝对坐标。**只在手工微调后出现**，一般不要写 |
| `children` | ❌ | 仅 `group` / `frame` 用，列出框住哪些节点 id |

### type 可选值

系统框图 `system_block` 可用（符合工程文档规范）：

```text
module  模块（默认）    io      输入输出接口    frame   层次框
group   分组框          note    注释            diamond 判断/条件
```

原理图 `schematic` / 旧 `block` 额外可用：

```text
reg     寄存器/触发器    adder   加法器          mult    乘法器
mux     多路选择         fifo    FIFO / 行缓存   ram     RAM/ROM
clock   时钟模块（PLL / MMCM / BUFG 用这个）
```

中文别名：模块、寄存器、触发器、加法器、乘法器、多路选择、缓存、存储器、时钟、端口、注释、分组、判断、层次框。

### ports 三种写法

```yaml
ports: "l:clk,rst_n | r:dout"     # 推荐：左侧 clk、rst_n，右侧 dout
ports: ["clk", "rst_n"]           # 全部放左边
ports: {left: [clk, rst_n], right: [dout]}
```

侧向可用 `l/r/t/b` 或 `left/right/top/bottom` 或 `左/右/上/下`。

**方向**（input / output / inout）用名字后缀，也可用对象写法：

| DSL | 含义 | 对象写法 |
|---|---|---|
| `awaddr<` | input | `{name: awaddr, dir: input}` |
| `wdata>` | output | `{name: wdata, dir: output}` |
| `s_axi<>` | inout | `{name: s_axi, dir: inout}` |

编辑器里选中节点后，右侧 **端口 / IO** 面板可以可视化添加、改名、改方向、改所在边、删除端口；改动会即时写回 DSL，源码始终是唯一可信源。

#### 插入 AXI 标准信号组

IO 面板的「插入信号组」内置三套标准接口：

| 信号组 | 信号数 | 用途 |
|---|---|---|
| AXI4-Lite | 19 | 寄存器配置，`AW* / W* / B* / AR* / R*` |
| AXI4-Stream | 8 | 单向数据流，`TVALID / TREADY / TDATA / TKEEP / TLAST / TID / TDEST / TUSER` |
| AXI4-Full | 35 | 突发传输，含 `LEN / SIZE / BURST / LOCK / CACHE / QOS / REGION / LAST` |

选 `master` 或 `slave` 自动翻转方向，可填前缀（如 `m_` / `s_`）。展开后就是一堆普通端口，**没有私有格式**，可逐个改名、改方向、删除；端口较多时节点会自动放大、并均匀分到四边。

端口名可以带位宽下标，连线时写全名即可（方括号里的冒号不会被当成标签分隔符）：

```yaml
nodes:
  - {id: cpu, label: CPU, ports: "r: awaddr[19:0] | r: wdata[31:0]"}
  - {id: ddr, label: DDR, ports: "l: awaddr[19:0] | l: wdata[31:0]"}
edges:
  - cpu.awaddr[19:0] -> ddr.awaddr[19:0] : AXI4
```

### 边（edges）

一行字符串是首选写法：

```text
- A.p -> B.p : 标签
- A -> B            # 箭头指向 B
- A <-> B           # 双向
- A --> B           # 箭头指向 B
- A -- B            # 无箭头
```

样式有**两种写法**：

1. **显式**（推荐，不会和信号名打架）：`- a -> b : 数据 style:bus route:curve`
2. **裸关键字**：只在标签整串就一个词时生效，`- a -> b : 总线` 等价于 `style:bus`（兼容旧写法）

| 关键字 | 效果 |
|---|---|
| `bus` / `总线` | 粗线，表示总线 |
| `clock` / `clk` / `时钟` | 时钟线样式 |
| `ctrl` / `control` / `控制` | 虚线，表示控制信号 |
| `orth` / `折线` | 正交折线（**解析默认**，老图纸不变） |
| `straight` / `直线` | 直线 |
| `curve` / `曲线` | 贝塞尔曲线 |

> 标签有多个词时**不会**再被吞掉：`- a -> b : clk 32bit` 的文字就是 `clk 32bit`（样式仍为默认）。
> 想同时要文字和样式，用显式写法：`- a -> b : clk 32bit style:clock`。

**编辑器里新画的连线默认是直线**（`straight`），工程图习惯如此；选中连线可在属性面板切回折线。DSL 解析默认值仍是 `orth`，所以旧图纸里没写 `route` 的连线不会变样。

也可以写成映射（等价，但更啰嗦）。要**指定箭头从哪条边进出**（在编辑器里插入节点后会自动写上）：

```yaml
edges:
  - {from: vin.dout, to: fifo.din, label: 24bit, style: bus, route: orth, arrow: end}
  - {from: a, to: {node: mid, side: l}}
  - {from: {node: mid, side: r}, to: b}
```

`side` 取 `l/r/t/b`，表示这条线接到该节点的哪条边的**中点**。

### 布局

```yaml
options:
  direction: LR     # LR 从左到右（默认）；TB / TD 从上到下
  layout: auto      # auto（默认）| layered 分层 | circular 环形 | manual 用 pos
```

框图的 `auto` 是分层布局：按连线拓扑分列，再在列内垂直排开。

---

## 2. 状态机（fsm）

```yaml
kind: fsm
title: AXI 突发读控制器
states:
  - {id: IDLE,  type: init, label: 空闲}
  - {id: ADDR,  label: 发地址}
  - {id: BURST, label: 突发传输}
  - {id: WAIT,  label: 等数据}
  - {id: DONE,  type: final, label: 完成}
transitions:
  - IDLE -> ADDR : req
  - ADDR -> BURST : ready
  - BURST -> WAIT : cnt < len / cmd_sent
  - WAIT -> BURST : first_valid
  - WAIT -> DONE : cnt = len
  - DONE -> IDLE : ack
```

### 状态字段

| 字段 | 说明 |
|---|---|
| `id` | 状态名（通常是 `IDLE` 这类大写标识符） |
| `type` | `state`（默认）/ `init` 初始实心点 / `final` 双圆终态 / `junction` 小菱形 |
| `label` | 圆角框里的文字，缺省用 `id`。`init` / `final` 不显示文字 |
| `pos` | 同框图，一般不要写 |

### 转移

```text
- A -> B              # 无条件
- A -> B : 条件       # 条件写在冒号后
- A -> B : 条件 / 动作 # 斜杠分隔条件和动作，画成 "条件 / 动作"
- A -> A : 重试        # 自环自动画成回到自己
```

同一对状态之间的**双向转移会自动分道**，不会重叠。

`fsm` 的 `layout: auto` 是环形布局：从入口状态开始沿转移遍历，按"走一遍"的顺序把状态摆在圆周上，
`init` 实心点贴在第一状态外侧、`final` 双圆贴在最后一个状态外侧。环形态下转移默认画成曲线
（写 `: straight` / `: 直线` 可以强制直线），因为正交折线在圆周上会绕成一团。

---

## 3. 时序波形（timing）

```yaml
kind: timing
title: AXI 写通道时序
tick: 5                # 每拍多少 ns（默认 10）

panels:                # 多组时序：纵向堆在同一张图，各有各的时长与时间轴
  - title: 写地址通道
    steps: 20
    signals:
      - {name: aclk,    type: clock, freq: 100}
      - {name: awvalid, type: logic, values: "0 1 1 1 1 0 0 0 0 0 . . . . . . . . . ."}
      - {name: awready, type: logic, values: "0 0 0 1 1 0 0 0 0 0 . . . . . . . . . ."}
      - {name: awaddr,  type: bus,   values: ". . A0 . . . . . . z . . . . . . . . . ."}
  - title: 写数据通道
    steps: 20
    signals:
      - {name: clk_50,  type: clock, freq: 50}
      - {name: wvalid,  type: logic, values: "0 0 0 1 1 1 0 0 0 0 . . . . . . . . . ."}
      - {name: wdata,   type: bus,   values: ". . . D0 D1 D2 . . . z . . . . . . . . . ."}
```

只画一组时可以不写 `panels`，退化成老写法：

```yaml
kind: timing
steps: 12
signals:
  - {name: clk,   type: clock, period: 2}
  - {name: valid, type: logic, values: "0 0 1 1 1 1 1 1 0 0 0 0"}
```

### 行字段

| 字段 | 说明 |
|---|---|
| `name` | 信号名（左侧标签） |
| `type` | `clock` 时钟 / `logic` 单比特 / `bus` 总线 / `group` 分组标题 |
| `values` | 每拍一个值，空格或逗号分隔；也接受 `1111100000` 这种压缩串 |
| `freq` | 仅 clock：**频率 MHz**，推荐写法。写了它周期自动换算 |
| `period` | 仅 clock：多少拍一个周期（不写 freq 时用），默认 2 |
| `duty` | 仅 clock：占空比，默认 0.5 |
| `phase` | 仅 clock：相位（拍） |
| `color` | 可选颜色覆盖：`#e11` / `#ee1111` / `red` / `steelblue`。波形与右侧属性面板的「颜色」框同步；写错格式会被忽略并给提示 |

### 多时钟系统

- `tick` 是**网格分辨率**（每拍多少 ns），时间轴按 ns 标。
- 写 `freq` 的时钟会按 ns 换算成拍数；一旦有高频时钟，`tick` 会自动细化到"最快时钟的半周期"，
  这样 `100MHz` 和 `50MHz` 叠在同一张图上不会错位（前者 2 拍一个周期，后者 4 拍）。
- 换算关系：`period(拍) = 1e3 / freq(MHz) / tick`，向下取偶；`duty`/`phase` 仍以拍为单位。

### values 规则（重点）

`logic`（单比特）：

- `0` `1` 电平；`z` 高阻（画虚线）；`x` 不定（画打叉方块）。
- `.` 表示**保持上一拍**（连续多个 `.` 就是一个平台）。

`bus`（总线）：

- 每格填值名：`A0`、`D0`、`0x1F`、`IDLE`。
- `.` 表示**延续上一段**：值一直有效到下一个显式值。
- 段的边界**永远落在格线上**，值宽 1 格就是 1 拍；想要"半拍翻转"，把 `tick` 设成时钟的半周期即可。
- 中途断开（总线释放 / 无效）写 `z`，会画成中间虚线段。
- 行尾剩下的 `.` 继续延续最后一段；要提前结束就写 `z`。

通用：

- 长度不足自动补齐到该组 `steps`；`steps` 不写时取最长一行，最少 4 拍、最多 512 拍。
- 每组 `steps` 独立，所以"写通道 20 拍 + 读通道 12 拍"可以放在同一张图里。

---

## 4. 手工定位（可选，一般别写）

拖动节点后编辑器会自动回写 `pos: [x, y]`，此时的坐标是**绝对画布坐标**（左上角为原点）。
一旦某个节点有 `pos`，它就固定在那儿；没有 `pos` 的节点仍参与自动布局。

所以：**AI 生成时不要写 `pos`**。人工微调之后，AI 再改文件时应保留已有的 `pos`，
只改文字和连线，否则会把用户的手工排版冲掉。

---

## 5. 校验与错误

命令行：

```bash
npx fpga-diagram validate a.fpgad --json   # 返回 {ok, diagnostics:[...], scenes:[...]}
npx fpga-diagram render  a.fpgad -o a.svg  # 出图；多视图用 --scene 2 指定第几页
npx fpga-diagram fmt     a.fpgad           # 归一化格式（不改语义，多视图整体保留）
```

常见错误与修法（`error` 会阻止命令行出图，`warning` 只提示）：

| 提示 | 级别 | 原因 | 修法 |
|---|---|---|---|
| `第 N 行：语法错误` | error | YAML 缩进/引号不对 | 列表项统一 2 空格缩进；含 `:` 的标签加引号 |
| `连线引用了不存在的节点 "fifo2"` | error | id 拼错 | 看提示里的「可用节点」列表，改成正确的 id |
| `无法解析连线（应写成 A -> B）` | error | 少了箭头 | 用 `->` / `<->` / `--` |
| `节点 id 重复` | error | 同一个 id 写了两次 | 改掉后者 |
| `有一个节点缺少 id` | error | 三项都没有 | 至少给 `id`、`name`、`label` 之一 |
| `panels 必须是非空列表` | error | `panels:` 下面没内容 | 删掉 `panels` 用单组写法，或补一组 |
| `没有解析到任何节点` | warning | 列表字段名不对 | 必须是 `nodes`（fsm 可为 `states`） |
| `[规范提示] 加法器属于底层原理图组件…` | warning | `system_block` 里写了底层原语 | 移到 `schematic` 视图，或换成 `module` |

每条诊断都带行号，直接照着改即可。行号按**出现位置**算：两个同名节点、第二条坏连线都能报到自己那一行。

编辑器里的表现：

- 语法坏到画不出任何图元时，**画布保留上一版**，上方弹红色横幅列出前 5 条错误（带行号），改对后自动消失；
- 只是局部出错（比如某条连线指向不存在的节点）时照常渲染其余部分，状态栏显示错误数；
- 所有诊断同步到 **Problems 面板**（来源 `FPGA Diagram`），warning 不阻断渲染。

---

## 6. 让 AI 一次写对的建议

1. 先想清楚**有几个节点、谁连谁**，再补 `type`、`label`。
2. 节点用**英文短 id**（`vin`、`fifo`、`scaler`），中文只放 `label`。
3. 边一律用 `A -> B : 标签` 单行写法，最不容易出错。
4. 不写 `pos`、不写 `size`、不写 `options`，除非真的有特殊要求。
5. 时序图里时钟写 `freq`，多组波形用 `panels`，总线的"无效段"用 `z`。
6. 写完调一次 `validate`，按行号修，再 `render` 看效果。

---

## 7. v2 完整示例（version: '2.0'）

下面是一份**合法**的 v2 多视图文档，涵盖文档头、场景 id/layout、样式、位宽、拐点、时序 group 子信号。
注意 `scenes:` 的每一项都要以 `- ` 开头（这是 YAML 列表，漏掉会解析失败）：

```yaml
version: '2.0'
meta:
  title: 视频处理子系统
  author: 张三
options:
  grid: true
  gridSize: 20
  snapToGrid: true
active: 0
scenes:
  - id: arch
    kind: system_block
    title: 系统架构
    layout:
      strategy: auto        # auto / layered / grid / manual / sugiyama / force
      direction: LR         # LR / TB / RL / BT
      nodeSpacing: 80
      layerSpacing: 60
    nodes:
      - id: camera
        type: io
        label: Camera Input
        ports:
          - {name: pixel, side: right, dir: output, width: '8'}
      - id: scaler
        type: module
        label: Scaler
        sub: 1920x1080 → 1280x720
        style: {fill: '#eef', stroke: '#557', dashed: false}
      - id: frame0
        type: frame
        label: 输出子系统
        children: [scaler]
        collapsed: false
    edges:
      - {from: camera.pixel, to: scaler, waypoints: [[110, 40], [150, 40]], visual: {stroke: '#c33', dashed: true}}

  - id: ctrl
    kind: fsm
    title: 控制状态机
    states:
      - {id: idle, label: IDLE}
      - {id: run, label: RUN}
    transitions:
      - idle -> run : start
      - run -> idle : done

  - id: wave
    kind: timing
    title: 写读时序
    tick: 5
    panels:
      - title: 写通道
        steps: 16
        signals:
          - {name: clk, type: clock, freq: 100}
          - {name: awaddr, type: bus, width: '[19:0]', order: 1, values: '. A0 A1 z'}
          - name: ctrl
            type: group
            children:
              - {name: wen, type: logic, values: '0101'}
              - {name: wdata, type: bus, width: 32, values: '1 2 3 4'}
      - title: 读通道
        steps: 16
        signals:
          - {name: clk50, type: clock, freq: 50}
          - {name: rdata, type: bus, values: '. . D0 D1 . . z'}
```

### v2 字段速查

| 位置 | 字段 | 说明 |
|---|---|---|
| 顶层 | `version: '2.0'` | 唯一决定是否为 v2；不写就是 v1 |
| 顶层 | `meta` / `options` | 元数据 / 全局显示选项 |
| 场景 | `id` / `layout` | 场景标识 / 布局策略对象 |
| 节点 | `style` / `collapsed` / `data` | 样式覆盖 / 折叠 / 自定义数据 |
| 端口 | `width` / `dir` | 位宽 / `input\|output\|inout` |
| 连线 | `waypoints` / `visual` | 手工拐点 `[[x,y],…]` / 视觉覆盖 |
| 信号 | `width` / `order` / `children` | 位宽 / 排序值 / group 子信号 |

> 兼容提示：v1 里端口名本身带位宽（`awaddr[19:0]`）依然有效，解析器会自动提取成 `width`；
> 显式 `width` 字段与名字里的 `[…]` 二者等价，写哪个都行。
