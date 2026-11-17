/**
 * 交互状态机（设计稿 4.2 的 Interaction Manager）。
 *
 * 画布交互本质是有限状态机：任一时刻只处于一个状态，只有合法转移才被接受。
 * 这里把状态与转移显式化，便于审计、测试，也让 UI 能根据状态切换光标/提示。
 * 各状态的具体业务行为仍由 webview 的事件处理器实现，本模块负责"状态是否正确"。
 */

export type InteractionState =
  | 'IDLE'
  | 'SELECTING'
  | 'DRAGGING'
  | 'LINKING'
  | 'RESIZING'
  | 'REORDERING'
  | 'WAYPOINT'
  | 'PAINTING'
  | 'PANNING'
  | 'PALACING';

/** 合法的直接转移表。任何不在表里的转移都会被 begin() 拒绝并保持原状态。 */
const TRANSITIONS: Record<InteractionState, InteractionState[]> = {
  IDLE: ['SELECTING', 'DRAGGING', 'LINKING', 'RESIZING', 'REORDERING', 'WAYPOINT', 'PAINTING', 'PANNING', 'PALACING'],
  SELECTING: ['IDLE', 'DRAGGING', 'LINKING', 'RESIZING'],
  DRAGGING: ['IDLE'],
  LINKING: ['IDLE'],
  RESIZING: ['IDLE'],
  REORDERING: ['IDLE'],
  WAYPOINT: ['IDLE'],
  PAINTING: ['IDLE'],
  PANNING: ['IDLE'],
  PALACING: ['IDLE'],
};

/** 原始拖拽 mode → 状态机状态 */
export function modeToState(mode: string): InteractionState {
  switch (mode) {
    case 'pan':
      return 'PANNING';
    case 'resize':
      return 'RESIZING';
    case 'connect':
      return 'LINKING';
    case 'move':
      return 'DRAGGING';
    case 'paint':
      return 'PAINTING';
    case 'marquee':
      return 'SELECTING';
    case 'palette':
      return 'PALACING';
    case 'reorder':
      return 'REORDERING';
    case 'waypoint':
      return 'WAYPOINT';
    default:
      return 'IDLE';
  }
}

export class InteractionManager {
  private _state: InteractionState = 'IDLE';
  /** 记录被拒绝的非法转移，便于调试 */
  readonly rejected: Array<{ from: InteractionState; to: InteractionState }> = [];

  get state(): InteractionState {
    return this._state;
  }

  get busy(): boolean {
    return this._state !== 'IDLE';
  }

  /** 尝试转移；非法时返回 false 且不改状态 */
  begin(next: InteractionState): boolean {
    if (next === this._state) return true;
    if (!TRANSITIONS[this._state].includes(next)) {
      this.rejected.push({ from: this._state, to: next });
      return false;
    }
    this._state = next;
    return true;
  }

  /** 结束当前交互回到 IDLE */
  end(): void {
    this._state = 'IDLE';
  }

  /** IDLE 时对应的光标提示 */
  static cursor(state: InteractionState): string {
    switch (state) {
      case 'DRAGGING':
        return 'move';
      case 'RESIZING':
        return 'nwse-resize';
      case 'LINKING':
        return 'crosshair';
      case 'PANNING':
        return 'grabbing';
      case 'REORDERING':
        return 'ns-resize';
      case 'WAYPOINT':
        return 'grab';
      case 'PAINTING':
        return 'crosshair';
      default:
        return 'default';
    }
  }
}
