import { redo, undo } from '@codemirror/commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffController } from '../../src/app/diffController';
import { PaneLayout } from '../../src/core/paneLayout';
import { TabStore } from '../../src/core/tabStore';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import { EditorManager } from '../../src/editor/editorManager';

/** App と同じ構成（モデル + EditorManager）で、DiffController を単体で検証する */
describe('DiffController', () => {
  let hosts: HTMLElement[];
  let layout: PaneLayout;
  let store: TabStore;
  let editor: EditorManager;
  let diff: DiffController;
  let notices: string[];
  let docChanges: string[];

  const order = () => store.all.map((t) => t.id);

  function addTab(id: string, content: string): void {
    editor.addTab(id, 'plaintext', 'LF', content);
    store.create({ id, name: `${id}.txt` });
  }

  /** App.syncPanes 相当 */
  function syncPanes(): void {
    for (let i = 0; i < layout.count; i++) editor.attachPane(i, hosts[i]);
    for (let i = 0; i < 4; i++) editor.showInPane(i, i < layout.count ? layout.tabs[i] : null);
    editor.setActivePane(layout.active);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    hosts = [0, 1, 2, 3].map(() => {
      const el = document.createElement('div');
      document.body.append(el);
      return el;
    });
    notices = [];
    docChanges = [];
    layout = new PaneLayout();
    store = new TabStore();
    editor = new EditorManager({ ...DEFAULT_SETTINGS }, {
      onDocChange: (id) => {
        docChanges.push(id);
        diff.onDocChange(id);
      },
      onCursorActivity: () => {},
    });
    layout.events.on('change', syncPanes);
    diff = new DiffController({ layout, store, editor, notify: (m) => notices.push(m) });
    addTab('a', 'one\ntwo\nthree');
    addTab('b', 'one\n2\nthree\nfour');
    addTab('c', 'unrelated');
    addTab('d', 'dddd');
    layout.load({ count: 1, tabs: ['a'], active: 0 }, order(), true);
    store.activate('a');
    syncPanes();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const el of hosts) el.remove();
  });

  const marked = (host: HTMLElement, cls: string) => host.querySelectorAll(`.cm-line.${cls}`).length;
  const type = (id: string, text: string) => {
    const pane = layout.paneOf(id);
    editor.applyToTab(id, (s) => ({ changes: { from: s.doc.length, insert: text }, userEvent: 'input.type' }));
    return pane;
  };

  it('同じタブ同士・不正なペイン指定は開始できない', () => {
    expect(diff.start({ a: 'a', b: 'a', paneA: 0, paneB: 1 })).toBe(false);
    expect(diff.validate({ a: 'a', b: 'a', paneA: 0, paneB: 1 })).toContain('同じタブ');
    expect(diff.validate({ a: 'a', b: 'b', paneA: 0, paneB: 0 })).toContain('ペイン');
    expect(diff.validate({ a: 'a', b: 'x', paneA: 0, paneB: 1 })).toContain('見つかりません');
    expect(diff.active).toBe(false);
    expect(layout.count).toBe(1);
  });

  it('1 画面から 2 分割にして比較し、終了すると元の配置に戻る', () => {
    expect(diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 })).toBe(true);
    expect(layout.count).toBe(2);
    expect(layout.tabs).toEqual(['a', 'b']);
    expect(diff.status).toMatchObject({ a: 'a', b: 'b', total: 2, changed: 1, added: 1, deleted: 0 });
    expect(marked(hosts[0], 'cm-diff-chg')).toBe(1);
    expect(marked(hosts[1], 'cm-diff-chg')).toBe(1);
    expect(marked(hosts[1], 'cm-diff-add')).toBe(1);

    diff.end();
    expect(diff.active).toBe(false);
    expect(layout.toJSON()).toEqual({ count: 1, tabs: ['a'], active: 0 });
    expect(hosts[0].querySelectorAll('[class*="cm-diff-"]').length).toBe(0);
    expect(notices).toEqual([]);
  });

  it('タブや本文を複製せず、既存のタブをそのまま使う', () => {
    const before = order();
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    expect(order()).toEqual(before);
    expect(editor.getContent('a')).toBe('one\ntwo\nthree');
    expect(editor.getContent('b')).toBe('one\n2\nthree\nfour');
    diff.end();
    expect(editor.getContent('a')).toBe('one\ntwo\nthree');
  });

  it('同一内容なら差分なしになる', () => {
    editor.applyToTab('c', (s) => ({ changes: { from: 0, to: s.doc.length, insert: 'one\ntwo\nthree' } }));
    diff.start({ a: 'a', b: 'c', paneA: 0, paneB: 1 });
    expect(diff.status).toMatchObject({ total: 0, current: -1 });
    expect(hosts[0].querySelectorAll('[class*="cm-diff-"]').length).toBe(0);
    diff.next();
    diff.previous();
    expect(diff.status?.current).toBe(-1);
  });

  it('2 分割では左右のペインで比較し、比較先・比較元のペインを逆にもできる', () => {
    layout.setCount(2, order());
    diff.start({ a: 'b', b: 'a', paneA: 1, paneB: 0 });
    expect(layout.tabs).toEqual(['a', 'b']);
    expect(diff.panes).toEqual({ a: 1, b: 0 });
    // b が比較元: 'two' が 2 に変わり、four が増えている → A(b) 側に 2 と four、B(a) 側に two
    expect(marked(hosts[1], 'cm-diff-chg')).toBe(1);
    expect(marked(hosts[0], 'cm-diff-del')).toBe(0);
    expect(diff.status).toMatchObject({ added: 0, deleted: 1, changed: 1 });
  });

  it('3・4 分割では指定した 2 つのペインで比較し、他のペインは維持する', () => {
    layout.setCount(4, order());
    expect(layout.tabs).toEqual(['a', 'b', 'c', 'd']);
    diff.start({ a: 'c', b: 'd', paneA: 2, paneB: 3 });
    expect(layout.tabs).toEqual(['a', 'b', 'c', 'd']);
    expect(layout.count).toBe(4);
    expect(layout.active).toBe(2);
    expect(hosts[0].querySelectorAll('[class*="cm-diff-"]').length).toBe(0);
    expect(hosts[1].querySelectorAll('[class*="cm-diff-"]').length).toBe(0);
    expect(marked(hosts[2], 'cm-diff-chg')).toBe(1);

    // 比較するタブが別のペインに表示されていても、指定したペインへ移して比較する（他のペインは空になるだけ）
    diff.start({ a: 'a', b: 'd', paneA: 0, paneB: 2 });
    expect(layout.tabs).toEqual(['a', 'b', 'd', null]);
    expect(marked(hosts[0], 'cm-diff-chg')).toBe(3);
    expect(marked(hosts[2], 'cm-diff-chg')).toBe(1);
    // 比較対象を変更しても、比較開始前の配置（1 画面）を覚えている
    diff.end();
    expect(layout.toJSON()).toEqual({ count: 4, tabs: ['a', 'b', 'c', 'd'], active: 0 });
  });

  it('比較終了時、比較開始前のアクティブなペインとタブ配置を復元する', () => {
    layout.setCount(3, order());
    layout.setActive(1);
    const before = layout.toJSON();
    diff.start({ a: 'c', b: 'd', paneA: 0, paneB: 2 });
    expect(layout.tabs).toEqual(['c', 'b', 'd']);
    diff.end();
    expect(layout.toJSON()).toEqual(before);
  });

  it('比較中に分割数を変えた場合は、比較終了で配置を戻さない', () => {
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    layout.setCount(3, order());
    expect(diff.active).toBe(true);
    diff.end();
    expect(layout.count).toBe(3);
  });

  it('差分の前後移動は端で折り返し、現在の差分だけを強調する', () => {
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    expect(diff.status?.current).toBe(0);
    diff.next();
    expect(diff.status?.current).toBe(1);
    expect(marked(hosts[1], 'cm-diff-current')).toBe(1);
    diff.next();
    expect(diff.status?.current).toBe(0);
    diff.previous();
    expect(diff.status?.current).toBe(1);
    diff.previous();
    expect(diff.status?.current).toBe(0);
  });

  it('比較中の編集で差分を更新し、本文・Undo/Redo 履歴は保持される', () => {
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    expect(diff.status?.total).toBe(2);
    // B の 2 行目を A と同じ内容にする（表示中のペインで編集）
    editor.setActivePane(1);
    editor.view.dispatch({
      changes: { from: 4, to: 5, insert: 'two' },
      userEvent: 'input.type',
    });
    expect(docChanges).toEqual(['b']);
    // 再計算は少し遅れて行う（入力のたびに計算しない）
    expect(diff.status?.total).toBe(2);
    vi.advanceTimersByTime(2000);
    expect(diff.status).toMatchObject({ total: 1, added: 1, changed: 0 });
    expect(editor.getContent('b')).toBe('one\ntwo\nthree\nfour');

    expect(undo(editor.view)).toBe(true);
    expect(editor.getContent('b')).toBe('one\n2\nthree\nfour');
    vi.advanceTimersByTime(2000);
    expect(diff.status?.total).toBe(2);
    expect(redo(editor.view)).toBe(true);
    expect(editor.getContent('b')).toBe('one\ntwo\nthree\nfour');

    // 比較を終了しても編集内容と履歴は残る
    diff.end();
    expect(editor.getContent('b')).toBe('one\ntwo\nthree\nfour');
    layout.show('b', 0, true);
    expect(undo(editor.view)).toBe(true);
    expect(editor.getContent('b')).toBe('one\n2\nthree\nfour');
  });

  it('差分の強調表示は本文の変更履歴に入らない（比較の開始・終了・移動で Undo の内容が変わらない）', () => {
    editor.setActivePane(0);
    type('a', '!');
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    diff.next();
    diff.end();
    expect(editor.getContent('a')).toBe('one\ntwo\nthree!');
    editor.setActivePane(0);
    expect(undo(editor.view)).toBe(true);
    expect(editor.getContent('a')).toBe('one\ntwo\nthree');
    expect(undo(editor.view)).toBe(false);
  });

  it('比較中のタブが閉じられたら、比較を安全に終了する', () => {
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    // App.onStoreChange 'remove' 相当
    const index = store.indexOf('b');
    store.remove('b');
    editor.removeTab('b');
    layout.removeTab('b', order(), index);
    expect(diff.active).toBe(false);
    expect(notices.join()).toContain('閉じられた');
    expect(editor.hasTab('a')).toBe(true);
    expect(hosts[0].querySelectorAll('[class*="cm-diff-"]').length).toBe(0);
    expect(editor.getContent('a')).toBe('one\ntwo\nthree');
  });

  it('比較中のペインの表示が変わったら、比較を終了する', () => {
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    layout.show('c', 1, true);
    expect(diff.active).toBe(false);
    expect(notices.join()).toContain('表示が変わった');
    expect(layout.tabs).toEqual(['a', 'c']);
    expect(hosts[0].querySelectorAll('[class*="cm-diff-"]').length).toBe(0);
  });

  it('比較に使っていないペインの操作・アクティブなペインの切り替えでは終了しない', () => {
    layout.setCount(3, order());
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    layout.show('d', 2, true);
    layout.setActive(1);
    expect(diff.active).toBe(true);
    expect(notices).toEqual([]);
  });

  it('比較の対象外のタブが閉じられても、比較を続け、終了時は現在の表示で補う', () => {
    layout.setCount(3, order());
    layout.show('c', 2, false);
    const before = layout.toJSON();
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    const index = store.indexOf('c');
    store.remove('c');
    editor.removeTab('c');
    layout.removeTab('c', order(), index);
    expect(diff.active).toBe(true);
    diff.end();
    expect(layout.count).toBe(before.count);
    expect(layout.tabs.slice(0, 2)).toEqual(['a', 'b']);
  });

  it('タブをすべて入れ替える操作（バックアップ復元）では比較を終了できる', () => {
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    editor.clear();
    diff.end(false);
    expect(diff.active).toBe(false);
    expect(notices).toEqual([]);
  });

  it('比較終了後は再計算のタイマーが動かない', () => {
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    type('a', 'x');
    diff.end();
    vi.advanceTimersByTime(5000);
    expect(hosts[0].querySelectorAll('[class*="cm-diff-"]').length).toBe(0);
    expect(diff.status).toBeNull();
  });

  it('比較中の通知を購読できる', () => {
    const events: (number | undefined)[] = [];
    diff.events.on('change', () => events.push(diff.status?.total));
    diff.start({ a: 'a', b: 'b', paneA: 0, paneB: 1 });
    diff.end();
    expect(events.at(0)).toBe(2);
    expect(events.at(-1)).toBeUndefined();
  });

  it('日本語・大きめのファイルでも比較できる', () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `行${i}：これは日本語のテキストです。`);
    const edited = [...lines];
    edited[100] = '行100：変更された日本語のテキストです。';
    edited.splice(15000, 1);
    editor.applyToTab('c', (s) => ({ changes: { from: 0, to: s.doc.length, insert: lines.join('\n') } }));
    editor.applyToTab('d', (s) => ({ changes: { from: 0, to: s.doc.length, insert: edited.join('\n') } }));
    const t0 = performance.now();
    diff.start({ a: 'c', b: 'd', paneA: 0, paneB: 1 });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(diff.status).toMatchObject({ total: 2, changed: 1, deleted: 1 });
  });
});
