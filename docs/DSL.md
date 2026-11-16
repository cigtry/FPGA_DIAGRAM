# FPGA Diagram DSL 速查

> 这份文档是给 **AI / 脚本** 看的语法手册。写法刻意宽松：能省的字段都省，
> 你只需要描述"有哪些东西、谁连谁"，坐标由布局器自动计算。

一句话规则：**先写 `kind`，再写列表，边用一行 `A -> B : 标签`。**

---

## 0. 四个概念

| 概念 | 字段 | 用途 |
|---|---|---|
| `kind` | `block` | 系统框图：层次框、数据通路、模块互连 |
| | `fsm` | 状态机、协议流程 |
| | `timing` | 时序波形、总线读写时序 |
| **视图** | `scenes:` | 一个 `.fpgad` 里装多张图（页签切换，互不覆盖） |
| **时序组** | `panels:` | 一张时序图里纵向排多组波形，各有时长与时间轴 |

文件扩展名 `.fpgad`。内容可以是 YAML 子集，也兼容 JSON（以 `{` 开头的按 JSON 解析）。

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

## 1. 系统框图（block）

`block` 有两种版式，同一个 kind：

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

### type 可选值（block）

```text
module  模块（默认）        reg     寄存器/触发器     adder  加法器
mult    乘法器              mux     多路选择         fifo   FIFO / 行缓存
ram     RAM/ROM             clock   时钟模块         io     输入输出端口
note    注释                diamond 判断/条件       group  分组框
frame   层次框（硬件框图常用）
```

中文别名：模块、寄存器、触发器、加法器、乘法器、多路选择、缓存、存储器、时钟、端口、注释、分组、判断、层次框。

### ports 三种写法

```yaml
ports: "l:clk,rst_n | r:dout"     # 推荐：左侧 clk、rst_n，右侧 dout
ports: ["clk", "rst_n"]           # 全部放左边
ports: {left: [clk, rst_n], right: [dout]}
```

侧向可用 `l/r/t/b` 或 `left/right/top/bottom` 或 `左/右/上/下`。

### 边（edges）

一行字符串是首选写法：

```text
- A.p -> B.p : 标签
- A -> B            # 箭头指向 B
- A <-> B           # 双向
- A -- B            # 无箭头
```

标签里的**关键字会被自动识别成样式**，剩下的才是文字：

| 关键字 | 效果 |
|---|---|
| `bus` / `总线` | 粗线，表示总线 |
| `clock` / `clk` / `时钟` | 时钟线样式 |
| `ctrl` / `control` / `控制` | 虚线，表示控制信号 |
| `orth` / `折线` | 正交折线（默认） |
| `straight` / `直线` | 直线 |
| `curve` / `曲线` | 贝塞尔曲线 |

例：`- vin.dout -> fifo.din : "24bit bus"` → 显示文字 `24bit`，画成粗总线。
标签要空着但又要指定样式时写 `: bus`。

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
| `color` | 可选颜色覆盖 |

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

每条诊断都带行号，直接照着改即可。

---

## 6. 让 AI 一次写对的建议

1. 先想清楚**有几个节点、谁连谁**，再补 `type`、`label`。
2. 节点用**英文短 id**（`vin`、`fifo`、`scaler`），中文只放 `label`。
3. 边一律用 `A -> B : 标签` 单行写法，最不容易出错。
4. 不写 `pos`、不写 `size`、不写 `options`，除非真的有特殊要求。
5. 时序图里时钟写 `freq`，多组波形用 `panels`，总线的"无效段"用 `z`。
6. 写完调一次 `validate`，按行号修，再 `render` 看效果。
