import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { InteractionManager, InteractionState, modeToState } from '../src/core/interaction';

describe('InteractionManager 状态机', () => {
  it('初始为 IDLE', () => {
    const m = new InteractionManager();
    assert.equal(m.state, 'IDLE');
    assert.equal(m.busy, false);
  });

  it('IDLE 可进入任意交互态，end 回到 IDLE', () => {
    const m = new InteractionManager();
    assert.equal(m.begin('DRAGGING'), true);
    assert.equal(m.state, 'DRAGGING');
    assert.equal(m.busy, true);
    m.end();
    assert.equal(m.state, 'IDLE');
  });

  it('交互态中只能回到 IDLE，不能横跳', () => {
    const m = new InteractionManager();
    m.begin('DRAGGING');
    assert.equal(m.begin('LINKING'), false, 'DRAGGING 不能直接跳到 LINKING');
    assert.equal(m.state, 'DRAGGING');
    assert.deepEqual(m.rejected, [{ from: 'DRAGGING', to: 'LINKING' }]);
    assert.equal(m.begin('IDLE'), true);
    assert.equal(m.state, 'IDLE');
  });

  it('mode 到 state 的映射覆盖所有拖拽模式', () => {
    const cases: [string, InteractionState][] = [
      ['pan', 'PANNING'],
      ['resize', 'RESIZING'],
      ['connect', 'LINKING'],
      ['move', 'DRAGGING'],
      ['paint', 'PAINTING'],
      ['marquee', 'SELECTING'],
      ['palette', 'PALACING'],
      ['reorder', 'REORDERING'],
      ['waypoint', 'WAYPOINT'],
      ['unknown', 'IDLE'],
    ];
    for (const [mode, state] of cases) assert.equal(modeToState(mode), state, mode);
  });

  it('光标提示随状态变化', () => {
    assert.equal(InteractionManager.cursor('DRAGGING'), 'move');
    assert.equal(InteractionManager.cursor('LINKING'), 'crosshair');
    assert.equal(InteractionManager.cursor('IDLE'), 'default');
  });
});
