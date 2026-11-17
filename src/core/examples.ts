export const BLOCK_SAMPLE = `# FPGA Diagram · block
# 只写结构，坐标自动计算；拖动画布后会把 pos 回写到节点行
kind: block
title: 图像缩放流水线

nodes:
  - {id: vin,  type: module, label: 视频输入, sub: video_in, ports: "l:clk,rst_n | r:dout,de"}
  - {id: csc,  type: module, label: 色彩空间转换, sub: RGB → YUV}
  - {id: fifo, type: fifo,   label: 行缓存, sub: 2 × 2048}
  - {id: scal, type: module, label: 双线性缩放, sub: 4×4 邻域}
  - {id: vout, type: io,     label: 视频输出}

edges:
  - vin.dout -> csc.din : 24bit bus
  - csc.dout -> fifo.din : 24bit bus
  - fifo.dout -> scal.din : 24bit bus
  - scal.dout -> vout.din : 24bit bus
`;

export const FSM_SAMPLE = `# FPGA Diagram · fsm
kind: fsm
title: DDR 突发读控制器

states:
  - {id: IDLE,  type: init,  label: 复位}
  - {id: ARB,   label: 仲裁, sub: 等待授权}
  - {id: CMD,   label: 发命令}
  - {id: WAIT,  label: 等数据}
  - {id: BURST, label: 突发传输}
  - {id: DONE,  type: final, label: 完成}

transitions:
  - IDLE -> ARB : req
  - ARB -> CMD : grant
  - CMD -> WAIT : cmd_sent
  - WAIT -> BURST : first_valid
  - BURST -> WAIT : cnt < len
  - BURST -> DONE : cnt = len
  - DONE -> IDLE : ack
`;

export const TIMING_SAMPLE = `# FPGA Diagram · timing
# 一条信号一行，多组时序用 panels（同图纵向排列，各有自己的时间轴）
# 时钟写 freq（MHz），多时钟按最快时钟自动细分网格；tick 是每拍多少 ns
# 单比特 values 用 0/1/z/x，. 表示保持；总线写值名，值保持到下一段
kind: timing
title: AXI 写通道时序
tick: 5

panels:
  - title: 写地址通道
    steps: 20
    signals:
      - {name: aclk, type: clock, freq: 100}
      - {name: awvalid, type: logic, values: "0 1 1 1 1 1 0 0 0 0 . . . . . . . . . ."}
      - {name: awready, type: logic, values: "0 0 0 1 1 0 0 0 0 0 . . . . . . . . . ."}
      - {name: awaddr, type: bus, values: ". . A0 . . . . . . z . . . . . . . . . ."}
  - title: 写数据通道
    steps: 20
    signals:
      - {name: clk_50, type: clock, freq: 50}
      - {name: wvalid, type: logic, values: "0 0 0 1 1 1 1 0 0 0 . . . . . . . . . ."}
      - {name: wdata, type: bus, values: ". . . D0 D1 D2 D3 . . . z . . . . . . . ."}
      - {name: bready, type: logic, values: "0 0 0 0 0 0 0 1 1 0 . . . . . . . . . ."}
`;

export const HIER_SAMPLE = `# FPGA Diagram · 层次框图
# frame = 层次框（实线/虚线、标题、框边界信号），子块用 pos 手工摆放
# 端口名后缀：< 入框，> 出框，<> 双向；不写则左边入、右边出
kind: block
options:
  layout: manual

nodes:
  - {id: top, type: frame, label: SoC_WDG, pos: [70, 60], size: [690, 470], ports: "l: s_axi_aclk, s_axi_aresetn, s_axi_awaddr[19:0]<>, axil_rd_data<> | r: wdt_reset, wdt_interrupt, timebase_interrupt, wdt_reset_pending"}
  - {id: axi, type: module, label: AXI4-Lite, sub: Interface, pos: [130, 120], size: [94, 330]}

  - {id: legacy, type: frame, label: Legacy WDT, style: dashed, titlePos: br, pos: [250, 80], size: [420, 210]}
  - {id: lreg, type: module, label: Legacy_reg, pos: [285, 115], size: [120, 66]}
  - {id: lctrl, type: module, label: Legacy_ctrl, pos: [470, 105], size: [130, 100]}
  - {id: tbase, type: frame, label: Timebase, style: dashed, titlePos: br, pos: [495, 140], size: [86, 46]}

  - {id: window, type: frame, label: Window WDT, style: dashed, titlePos: br, pos: [250, 330], size: [420, 160]}
  - {id: wreg, type: module, label: Window_reg, pos: [285, 365], size: [120, 66]}
  - {id: wctrl, type: module, label: Window_ctrl, pos: [470, 365], size: [130, 66]}

edges:
  - axi <-> lreg : straight
  - lreg <-> lctrl : straight
  - axi <-> wreg : straight
  - wreg <-> wctrl : straight
`;


export const MULTI_SAMPLE = `# FPGA Diagram · 多视图：一个文件里装系统框图 + 状态机 + 两组时序
# 编辑器顶部按页签切换，切走再切回内容都在
active: 0

scenes:
  - diagram_type: system_block
    title: 采集通路
    nodes:
      - {id: adc, type: io, label: ADC 输入, ports: "r:dout"}
      - {id: fifo, type: fifo, label: 采样缓存}
      - {id: dsp, type: module, label: 抽取滤波}
      - {id: dma, type: module, label: DMA 搬运}
    edges:
      - adc.dout -> fifo
      - fifo -> dsp : 16bit bus
      - dsp -> dma : 32bit bus

  - kind: fsm
    title: 采集状态机
    states:
      - {id: IDLE, type: init, label: 空闲}
      - {id: FILL, label: 填充}
      - {id: DRAIN, label: 搬运}
      - {id: DONE, type: final, label: 结束}
    transitions:
      - IDLE -> FILL : start
      - FILL -> DRAIN : half_full
      - DRAIN -> FILL : more
      - DRAIN -> DONE : last

  - kind: timing
    title: 采样与搬运时序
    tick: 5
    panels:
      - title: 采样
        steps: 16
        signals:
          - {name: adc_clk, type: clock, freq: 100}
          - {name: adc_valid, type: logic, values: "1 1 1 1 1 1 1 1 . . . . . . . ."}
          - {name: adc_data, type: bus, values: "A0 A1 A2 A3 A4 A5 A6 A7 z . . . . . . ."}
      - title: 搬运
        steps: 16
        signals:
          - {name: dma_clk, type: clock, freq: 50}
          - {name: dma_req, type: logic, values: "0 0 0 1 1 1 1 1 0 0 . . . . . ."}
          - {name: dma_data, type: bus, values: ". . . B0 B1 B2 B3 z . . . . . . . ."}
`;

export const SYSTEM_SAMPLE = `# FPGA Diagram · 系统框图
# system_block 放功能模块 / 接口 / 层次框，描述顶层连接关系
# 端口后缀：< 输入，> 输出，<> 双向；也可在右侧 IO 面板里可视化增删
diagram_type: system_block
title: SoC 顶层框图

nodes:
  - {id: top, type: frame, label: SoC, size: [620, 300], ports: "l: s_axi_aclk<, s_axi_aresetn<, s_axi_awaddr[19:0]<> | r: irq>"}
  - {id: axi, type: module, label: AXI4-Lite, sub: 寄存器配置, ports: "l: s_axi_aclk< | r: reg_write>"}
  - {id: core, type: module, label: 处理核心, ports: "l: reg_write< | r: data_valid>"}
  - {id: dma, type: module, label: DMA, ports: "l: data_valid< | r: m_axi_tdata>"}
  - {id: out, type: io, label: 对外接口}

edges:
  - top.s_axi_aclk -> axi.s_axi_aclk : straight
  - axi.reg_write -> core.reg_write : straight
  - core.data_valid -> dma.data_valid : straight
  - dma.m_axi_tdata -> out : straight
`;

export const SCHEMATIC_SAMPLE = `# FPGA Diagram · 原理图 / 微架构
# schematic 开放寄存器、加法器、乘法器、选择器、时钟等底层组件
diagram_type: schematic
title: 数据通路微架构

nodes:
  - {id: din, type: io, label: 数据输入}
  - {id: r0, type: reg, label: 输入寄存}
  - {id: mul, type: mult, label: 乘法器, sub: 16×16}
  - {id: mux, type: mux, label: 结果选择}
  - {id: add, type: adder, label: 累加}
  - {id: clk, type: clock, label: PLL, sub: 100MHz}
  - {id: dout, type: io, label: 数据输出}

edges:
  - din -> r0 : straight
  - r0 -> mul : straight
  - mul -> mux : straight
  - add -> mux : straight
  - mux -> dout : straight
  - clk -> r0 : clock
  - clk -> add : clock
`;

/** 模板名：system_block（系统框图）· schematic（原理图）· block（流程图）· hier（层次框图）· fsm · timing · multi */
export function sample(name: string): string {
  if (name === 'multi') return MULTI_SAMPLE;
  if (name === 'hier') return HIER_SAMPLE;
  if (name === 'system_block') return SYSTEM_SAMPLE;
  if (name === 'schematic') return SCHEMATIC_SAMPLE;
  if (name === 'datapath') return SCHEMATIC_SAMPLE.replace('diagram_type: schematic', 'diagram_type: datapath');
  return name === 'fsm' ? FSM_SAMPLE : name === 'timing' ? TIMING_SAMPLE : SYSTEM_SAMPLE;
}

export function sampleTitle(name: string): string {
  if (name === 'multi') return 'FPGA 采集系统';
  if (name === 'hier') return 'SoC_WDG';
  if (name === 'system_block') return 'SoC 顶层框图';
  if (name === 'schematic') return '数据通路微架构';
  if (name === 'datapath') return '数据通路';
  return name === 'fsm' ? 'DDR 突发读控制器' : name === 'timing' ? 'AXI 写通道时序' : 'SoC 顶层框图';
}
