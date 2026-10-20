import { describe, expect, it } from 'vitest';
import { PaneLayout } from '../../src/core/paneLayout';

const ids = ['t1', 't2', 't3', 't4', 't5'];

function layoutWith(tabs: (string | null)[], active = 0): PaneLayout {
  const l = new PaneLayout();
  l.load({ count: tabs.length, tabs, active }, ids, true);
  return l;
}

describe('PaneLayout', () => {
  it('初期状態は 1 画面', () => {
    const l = new PaneLayout();
    expect(l.toJSON()).toEqual({ count: 1, tabs: [null], active: 0 });
  });

  it('分割数を増やすと、表示中のタブの次から順に未表示のタブを割り当てる', () => {
    const l = layoutWith(['t2']);
    l.setCount(4, ids);
    expect(l.tabs).toEqual(['t2', 't3', 't4', 't5']);
    expect(l.active).toBe(0);
    const l2 = layoutWith(['t1']);
    l2.setCount(3, ids);
    expect(l2.tabs).toEqual(['t1', 't2', 't3']);
  });

  it('タブ数がペイン数より少なければ空のペインになる', () => {
    const l = new PaneLayout();
    l.load({ count: 1, tabs: ['t1'] }, ['t1', 't2'], true);
    l.setCount(4, ['t1', 't2']);
    expect(l.tabs).toEqual(['t1', 't2', null, null]);
  });

  it('分割数を減らすと後ろのペインだけ閉じ、アクティブペインを補正する', () => {
    const l = layoutWith(['t1', 't2', 't3', 't4'], 3);
    l.setCount(2, ids);
    expect(l.tabs).toEqual(['t1', 't2']);
    expect(l.active).toBe(1);
    expect(l.paneOf('t3')).toBe(-1);
  });

  it('タブは 1 つのペインにだけ表示する（移動時は元のペインから外す）', () => {
    const l = layoutWith(['t1', 't2', 't3']);
    l.show('t3', 0);
    expect(l.tabs).toEqual(['t3', 't2', null]);
    expect(l.active).toBe(0);
    l.show('t1', 2, false);
    expect(l.tabs).toEqual(['t3', 't2', 't1']);
    expect(l.active).toBe(0);
  });

  it('タブの削除時は近くの未表示タブで補い、なければ空にする', () => {
    const l = layoutWith(['t1', 't2']);
    // t1 を削除（削除後の並び t2..t5、削除位置 0）→ t2 は表示中なので t3
    l.removeTab('t1', ['t2', 't3', 't4', 't5'], 0);
    expect(l.tabs).toEqual(['t3', 't2']);
    // 末尾のタブを削除 → 左隣
    const l2 = layoutWith(['t5', 't1']);
    l2.removeTab('t5', ['t1', 't2', 't3', 't4'], 4);
    expect(l2.tabs).toEqual(['t4', 't1']);
    // 補えるタブがない
    const l3 = new PaneLayout();
    l3.load({ count: 2, tabs: ['a', 'b'] }, ['a', 'b'], true);
    l3.removeTab('b', ['a'], 1);
    expect(l3.tabs).toEqual(['a', null]);
  });

  it('保存データの不正な値を補正する', () => {
    const l = new PaneLayout();
    l.load({ count: 9 as number, tabs: ['t1'], active: 5 }, ids, true);
    expect(l.toJSON()).toEqual({ count: 1, tabs: ['t1'], active: 0 });
    l.load({ count: 3, tabs: ['t1', 't1', 'gone'], active: 2 }, ids, true);
    expect(l.toJSON()).toEqual({ count: 3, tabs: ['t1', null, null], active: 2 });
  });

  it('存在しないタブを外す', () => {
    const l = layoutWith(['t1', 't2']);
    l.reconcile(['t2']);
    expect(l.tabs).toEqual([null, 't2']);
  });

  it('変更を通知する', () => {
    const l = layoutWith(['t1', 't2']);
    let n = 0;
    l.events.on('change', () => n++);
    l.setActive(1);
    l.setActive(1); // 変化なし
    l.show('t2', 1); // 変化なし
    l.setCount(3, ids);
    expect(n).toBe(2);
  });
});
