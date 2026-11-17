import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CommandStore, Snapshot } from '../src/core/commands';

function snap(nodes: string[], active = 0): Snapshot {
  return { scenes: [{ kind: 'block', nodes: nodes.map((id) => ({ id })), edges: [] }], active };
}

describe('CommandStore 撤销重做', () => {
  it('commit 后可撤销回初始状态，再重做回来', () => {
    const s = new CommandStore(snap(['a']));
    s.commit(snap(['a', 'b']), '添加节点');
    assert.equal(s.current.scenes[0].nodes.length, 2);
    assert.equal(s.canUndo(), true);

    const undone = s.undo()!;
    assert.equal(undone.scenes[0].nodes.length, 1);
    assert.equal(s.canRedo(), true);

    const redone = s.redo()!;
    assert.equal(redone.scenes[0].nodes.length, 2);
  });

  it('新 commit 会清空 redo 栈', () => {
    const s = new CommandStore(snap(['a']));
    s.commit(snap(['a', 'b']), 'add');
    s.undo();
    assert.equal(s.canRedo(), true);
    s.commit(snap(['a', 'c']), 'add2');
    assert.equal(s.canRedo(), false);
  });

  it('相同 mergeKey 的连续命令合并，撤销一次回到最开始', () => {
    const s = new CommandStore(snap(['a']));
    s.commit(snap(['a'], 0), '移动', 'move-a');
    s.commit(snap(['a'], 0), '移动', 'move-a');
    // 用不同坐标模拟拖拽：这里直接构造最终状态
    const moved = snap(['a']);
    moved.scenes[0].nodes[0].x = 100;
    s.commit(moved, '移动', 'move-a');
    const undone = s.undo()!;
    assert.equal(undone.scenes[0].nodes[0].x, undefined, '撤销应回到拖拽前');
    assert.equal(s.canUndo(), false, '合并后只占一条历史');
  });

  it('不同 mergeKey 不合并', () => {
    const s = new CommandStore(snap(['a']));
    s.commit(snap(['a', 'b']), '移动a', 'move-a');
    s.commit(snap(['a', 'b', 'c']), '移动b', 'move-b');
    s.undo();
    assert.equal(s.current.scenes[0].nodes.length, 2);
    s.undo();
    assert.equal(s.current.scenes[0].nodes.length, 1);
  });

  it('批量事务合成一条，撤销回到事务前', () => {
    const s = new CommandStore(snap(['a']));
    s.beginBatch();
    s.commit(snap(['a', 'b']), '插入信号组-1', 'group');
    s.commit(snap(['a', 'b', 'c']), '插入信号组-2', 'group');
    s.commitBatch('插入 AXI 信号组');
    assert.equal(s.current.scenes[0].nodes.length, 3);
    assert.equal(s.undoLabel(), '插入 AXI 信号组');
    s.undo();
    assert.equal(s.current.scenes[0].nodes.length, 1);
    assert.equal(s.canUndo(), false);
  });

  it('abortBatch 不污染 current 也不入栈', () => {
    const s = new CommandStore(snap(['a']));
    s.beginBatch();
    s.commit(snap(['a', 'b']), 'x');
    s.abortBatch();
    assert.equal(s.canUndo(), false);
  });

  it('reset 清空历史，snapshot 是深拷贝', () => {
    const initial = snap(['a']);
    const s = new CommandStore(initial);
    s.commit(snap(['a', 'b']), 'x');
    s.reset(snap(['z']));
    assert.equal(s.canUndo(), false);
    assert.equal(s.current.scenes[0].nodes[0].id, 'z');
    assert.equal(initial.scenes[0].nodes.length, 1, '构造时的入参不应被后续修改');
  });
});
