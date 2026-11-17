/**
 * Command 模式的撤销/重做存储（设计稿 5.x 的 Command Log）。
 *
 * 每个命令记录变更前后的整份文档快照（SceneFile 的深拷贝），并带一条可读标签。
 * 相比原来 webview 里散落的 JSON.stringify(snapshot)，这里集中管理：
 * - 支持连续拖拽合并（同 mergeKey 的相邻命令压成一条，撤销一次回到拖拽前）；
 * - 支持批量事务（beginBatch/commitBatch：一次用户操作产生的多条命令合并成一条）；
 * - 撤销/重做栈有上限，且完全可序列化，方便将来做跨会话历史。
 *
 * 纯 TS，无 DOM 依赖，-editor / webview / CLI 都能用。
 */

export interface Snapshot {
  scenes: any[];
  active: number;
  version?: string;
  meta?: any;
  options?: any;
}

export interface Command {
  /** 变更前状态 */
  before: Snapshot;
  /** 变更后状态 */
  after: Snapshot;
  /** 可读标签，显示在 undo/redo 提示里 */
  label: string;
  /** 合并键：连续两条 key 相同且可合并时压成一条（拖拽场景） */
  mergeKey?: string;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function snapshotOf(state: Snapshot): Snapshot {
  return clone({
    scenes: state.scenes,
    active: state.active,
    ...(state.version ? { version: state.version } : {}),
    ...(state.meta ? { meta: state.meta } : {}),
    ...(state.options ? { options: state.options } : {}),
  });
}

/**
 * 命令历史。undo 栈与 redo 栈的元素都是 Command；
 * current 始终保持当前文档状态，调用方从 current 渲染。
 */
export class CommandStore {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  current: Snapshot;
  private batch: Command[] | null = null;
  private limit: number;

  constructor(initial: Snapshot, limit = 120) {
    this.current = snapshotOf(initial);
    this.limit = limit;
  }

  /** 记录一次变更。state 是变更后的完整状态，before 取当前状态。 */
  commit(state: Snapshot, label: string, mergeKey?: string): void {
    this.commitFrom(this.current, state, label, mergeKey);
  }

  /**
   * 用显式的 before/after 记录一次变更（webview 的 snapshot() 在改动前调用，
   * 改动在之后发生，因此 before 由调用方暂存后传进来）。
   */
  commitFrom(before: Snapshot, state: Snapshot, label: string, mergeKey?: string): void {
    const after = snapshotOf(state);
    const cmd: Command = { before: snapshotOf(before), after, label, mergeKey };
    this.current = after;

    if (this.batch) {
      this.batch.push(cmd);
      return;
    }
    this.pushMerged(cmd);
  }

  private pushMerged(cmd: Command): void {
    const top = this.undoStack[this.undoStack.length - 1];
    // 同 mergeKey 的相邻命令合并：保留最早的 before，用最新的 after
    if (cmd.mergeKey && top && top.mergeKey === cmd.mergeKey) {
      top.after = cmd.after;
      top.label = cmd.label;
    } else {
      this.undoStack.push(cmd);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  /** 撤销：返回撤销后的状态（即命令的 before）；无可撤销时返回 null */
  undo(): Snapshot | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    this.redoStack.push(cmd);
    this.current = snapshotOf(cmd.before);
    return this.current;
  }

  /** 重做：返回重做后的状态（命令的 after）；无可重做时返回 null */
  redo(): Snapshot | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    this.undoStack.push(cmd);
    this.current = snapshotOf(cmd.after);
    return this.current;
  }

  /** 开始批量事务：期间的 commit 不立即入栈，结束时合成一条 */
  beginBatch(): void {
    if (this.batch) return;
    this.batch = [];
  }

  /** 结束批量事务：把期间的命令合成一条（before 取最早，after 取最新） */
  commitBatch(label: string): void {
    if (!this.batch || !this.batch.length) {
      this.batch = null;
      return;
    }
    const cmds = this.batch;
    this.batch = null;
    const before = cmds[0].before;
    const after = cmds[cmds.length - 1].after;
    const merged: Command = { before, after, label };
    this.pushMerged(merged);
  }

  /** 丢弃批量事务（不改变 current） */
  abortBatch(): void {
    this.batch = null;
  }

  /** 外部文档被替换时清空历史（如打开文件） */
  reset(state: Snapshot): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.batch = null;
    this.current = snapshotOf(state);
  }
}
