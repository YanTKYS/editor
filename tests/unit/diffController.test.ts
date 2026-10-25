import { redo, undo } from '@codemirror/commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffController, type DiffTargets } from '../../src/app/diffController';
import { PaneLayout } from '../../src/core/paneLayout';
import { TabStore } from '../../src/core/tabStore';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import { EditorManager } from '../../src/editor/editorManager';

/** App と同じ構成（モデル + EditorManager）で、DiffController を単体で検証する */
describe('DiffController（比較元・比較先・結果表示の 3 ペイン方式）', () => {
  let hosts: HTMLElement[];
  let layout: PaneLayout;
  let store: TabStore;
  let editor: EditorManager;
  let diff: DiffController;
  let notices: string[];

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
    layout = new PaneLayout();
    store = new TabStore();
    editor = new EditorManager({ ...DEFAULT_SETTINGS }, {
      onDocChange: (id) => diff.onDocChange(id),
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

  /** 比較を開始する（ダイアログと同様に、配置の計画と初期値を使う） */
  const begin = (targets?: Partial<DiffTargets>): boolean => {
    const plan = diff.planLayout();
    return diff.start({ ...diff.defaultTargets(plan), ...targets }, plan);
  };
  const lines = (host: HTMLElement) => Array.from(host.querySelectorAll('.cm-line')).map((l) => l.textContent);
  const marked = (host: HTMLElement, cls: string) => host.querySelectorAll(`.cm-line.${cls}`).length;
  const noDiffMarks = (host: HTMLElement) => host.querySelectorAll('.cm-line[class*="cm-diff-"]').length === 0;

  describe('配置の計画とダイアログの初期値', () => {
    it('1 ペインでは 3 ペインに拡張し、比較元は現在のタブ、比較先は別の既存タブ、結果表示は空にする', () => {
      expect(diff.planLayout()).toEqual(['a', 'b', null]);
      expect(diff.defaultTargets(diff.planLayout())).toEqual({ a: 0, b: 1, result: 2 });
      // 拡張の計画を立てるだけでは、ペイン配置を変更しない
      expect(layout.toJSON()).toEqual({ count: 1, tabs: ['a'], active: 0 });
    });

    it('別のタブとして、内容のあるタブを優先する', () => {
      addTab('empty', '');
      layout.load({ count: 1, tabs: ['d'], active: 0 }, order(), true);
      syncPanes();
      expect(diff.planLayout()[1]).toBe('a');
    });

    it('2 ペインでは 3 ペインにして、結果表示の初期値を 3 つ目にする。空のペインには別のタブを割り当てる', () => {
      layout.load({ count: 2, tabs: ['c', 'd'], active: 1 }, order(), true);
      syncPanes();
      expect(diff.planLayout()).toEqual(['c', 'd', null]);
      expect(diff.defaultTargets(diff.planLayout())).toEqual({ a: 0, b: 1, result: 2 });
      layout.load({ count: 2, tabs: ['c', null], active: 0 }, order(), true);
      syncPanes();
      expect(diff.planLayout()).toEqual(['c', 'd', null]);
    });

    it('3・4 ペインでは既存の配置のまま、アクティブなペインを比較元にし、空のペインを結果表示にする', () => {
      layout.load({ count: 4, tabs: ['a', 'b', null, 'd'], active: 3 }, order(), true);
      syncPanes();
      expect(diff.planLayout()).toEqual(['a', 'b', null, 'd']);
      expect(diff.defaultTargets(diff.planLayout())).toEqual({ a: 3, b: 0, result: 2 });
    });
  });

  describe('検証', () => {
    const plan = ['a', 'b', 'c', null];

    it('同じペインを複数の役割に指定できない', () => {
      expect(diff.validate({ a: 0, b: 0, result: 2 }, plan)).toContain('別のペイン');
      expect(diff.validate({ a: 0, b: 1, result: 1 }, plan)).toContain('別のペイン');
      expect(diff.validate({ a: 0, b: 1, result: 0 }, plan)).toContain('別のペイン');
      expect(diff.validate({ a: 0, b: 1, result: 9 }, plan)).toContain('ペインを指定');
    });

    it('比較元・比較先が空のペインなら、タブが必要であることを案内する', () => {
      expect(diff.validate({ a: 3, b: 1, result: 2 }, plan)).toContain('比較元（ペイン 4）にはタブが表示されていません');
      expect(diff.validate({ a: 0, b: 3, result: 2 }, plan)).toContain('比較先（ペイン 4）にはタブが表示されていません');
    });

    it('結果表示のペインは空でも、既存のタブがあってもよい', () => {
      expect(diff.validate({ a: 0, b: 1, result: 3 }, plan)).toBeNull();
      expect(diff.validate({ a: 0, b: 1, result: 2 }, plan)).toBeNull();
    });

    it('不正な指定では開始せず、ペイン配置も変更しない', () => {
      const before = layout.toJSON();
      expect(diff.start({ a: 0, b: 0, result: 2 }, diff.planLayout())).toBe(false);
      expect(diff.start({ a: 0, b: 1, result: 5 }, diff.planLayout())).toBe(false);
      expect(diff.active).toBe(false);
      expect(layout.toJSON()).toEqual(before);
    });
  });

  describe('1・2 ペインからの拡張', () => {
    it('1 ペインから 3 ペインに拡張して比較し、終了すると 1 ペインに戻る', () => {
      expect(begin()).toBe(true);
      expect(layout.count).toBe(3);
      expect(layout.tabs).toEqual(['a', 'b', null]);
      expect(layout.active).toBe(0);
      expect(diff.status).toMatchObject({ aTab: 'a', bTab: 'b', total: 2, changed: 1, added: 1, deleted: 0 });
      expect(editor.hasOverlay(2)).toBe(true);
      expect(lines(hosts[2])).toEqual(['@@ -2,1 +2,1 @@', '- two', '+ 2', '', '@@ -3,0 +4,1 @@', '+ four']);

      diff.end();
      expect(diff.active).toBe(false);
      expect(layout.toJSON()).toEqual({ count: 1, tabs: ['a'], active: 0 });
      expect(editor.hasOverlay(2)).toBe(false);
      expect(notices).toEqual([]);
    });

    it('2 ペインから 3 ペインに拡張して比較し、終了すると 2 ペインに戻る', () => {
      layout.load({ count: 2, tabs: ['a', 'b'], active: 1 }, order(), true);
      syncPanes();
      expect(begin()).toBe(true);
      expect(layout.toJSON()).toEqual({ count: 3, tabs: ['a', 'b', null], active: 0 });
      diff.end();
      expect(layout.toJSON()).toEqual({ count: 2, tabs: ['a', 'b'], active: 1 });
    });

    it('タブや本文を複製・変更しない', () => {
      const before = order();
      begin();
      expect(order()).toEqual(before);
      expect(editor.getContent('a')).toBe('one\ntwo\nthree');
      expect(editor.getContent('b')).toBe('one\n2\nthree\nfour');
      diff.end();
      expect(editor.getContent('a')).toBe('one\ntwo\nthree');
      expect(editor.getContent('b')).toBe('one\n2\nthree\nfour');
    });

    it('結果表示のペインはタブとして扱わず、タブ配置には現れない', () => {
      begin();
      expect(layout.tabs[2]).toBeNull();
      expect(editor.paneOfTab('a')).toBe(0);
      expect(editor.activeTabId).toBe('a');
      expect(order()).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('3・4 ペインでの指定', () => {
    it('任意の比較元・比較先・結果表示ペインを指定できる（他のペインは維持する）', () => {
      layout.load({ count: 4, tabs: ['a', 'b', 'c', 'd'], active: 0 }, order(), true);
      syncPanes();
      expect(begin({ a: 3, b: 2, result: 0 })).toBe(true);
      // 結果表示にしたペインのタブは一時的に非表示。他のペインはそのまま
      expect(layout.tabs).toEqual([null, 'b', 'c', 'd']);
      expect(layout.active).toBe(3);
      expect(diff.status).toMatchObject({ aTab: 'd', bTab: 'c', a: 3, b: 2, result: 0 });
      expect(lines(hosts[0])[0]).toMatch(/^@@/);
      expect(noDiffMarks(hosts[1])).toBe(true);
      expect(marked(hosts[3], 'cm-diff-chg')).toBe(1);
    });

    it('結果表示のペインに既存のタブがあっても、終了時に元のタブを本文・Undo 履歴ごと復元する', () => {
      layout.load({ count: 3, tabs: ['a', 'b', 'c'], active: 2 }, order(), true);
      syncPanes();
      editor.setActivePane(2);
      editor.view.dispatch({ changes: { from: 9, insert: '!' }, userEvent: 'input.type' });
      expect(editor.getContent('c')).toBe('unrelated!');
      begin({ a: 0, b: 1, result: 2 });
      expect(layout.tabs).toEqual(['a', 'b', null]);
      expect(editor.getContent('c')).toBe('unrelated!');
      diff.end();
      expect(layout.toJSON()).toEqual({ count: 3, tabs: ['a', 'b', 'c'], active: 2 });
      expect(editor.getContent('c')).toBe('unrelated!');
      expect(undo(editor.view)).toBe(true);
      expect(editor.getContent('c')).toBe('unrelated');
      expect(redo(editor.view)).toBe(true);
      expect(editor.getContent('c')).toBe('unrelated!');
    });

    it('元々空だったペインは、アクティブな空ペインも含めて空のまま復元する', () => {
      layout.load({ count: 4, tabs: ['a', null, 'c', 'd'], active: 1 }, order(), true);
      syncPanes();
      const before = layout.toJSON();
      expect(begin({ a: 3, b: 0, result: 1 })).toBe(true);
      expect(layout.active).toBe(3);
      diff.end();
      expect(layout.toJSON()).toEqual(before);
      expect(layout.tabs).toEqual(['a', null, 'c', 'd']);
      expect(layout.active).toBe(1);
      expect(editor.hasOverlay(1)).toBe(false);
    });

    it('比較元・比較先に空のペインを指定すると開始できない', () => {
      layout.load({ count: 3, tabs: ['a', null, 'c'], active: 0 }, order(), true);
      syncPanes();
      const before = layout.toJSON();
      const plan = diff.planLayout();
      expect(diff.start({ a: 0, b: 1, result: 2 }, plan)).toBe(false);
      expect(layout.toJSON()).toEqual(before);
    });

    it('比較中に分割数を増やした場合は、比較を続け、終了時に配置を戻さない', () => {
      layout.load({ count: 3, tabs: ['a', 'b', 'c'], active: 0 }, order(), true);
      syncPanes();
      begin({ a: 0, b: 1, result: 2 });
      layout.setCount(4, order());
      expect(diff.active).toBe(true);
      diff.end();
      expect(layout.count).toBe(4);
      expect(layout.tabs.slice(0, 2)).toEqual(['a', 'b']);
    });

    it('比較中に分割数を増やした場合も、結果表示のために外したタブは、どこにも表示されていなければ元のペインに戻す', () => {
      layout.load({ count: 3, tabs: ['a', 'b', 'c'], active: 0 }, order(), true);
      syncPanes();
      begin({ a: 0, b: 1, result: 2 });
      layout.setCount(4, ['a', 'b']); // 追加したペインには、外したタブ以外が割り当てられる
      expect(layout.tabs).toEqual(['a', 'b', null, null]);
      diff.end();
      expect(layout.tabs).toEqual(['a', 'b', 'c', null]);
    });

    it('比較中に対象を変更しても、比較開始前の配置を覚えている', () => {
      layout.load({ count: 4, tabs: ['a', 'b', 'c', 'd'], active: 0 }, order(), true);
      syncPanes();
      const before = layout.toJSON();
      begin({ a: 0, b: 1, result: 2 });
      expect(layout.tabs).toEqual(['a', 'b', null, 'd']);
      // 結果表示を別のペインに変更すると、前の結果表示ペインのタブは元に戻る
      expect(begin({ a: 0, b: 1, result: 3 })).toBe(true);
      expect(layout.tabs).toEqual(['a', 'b', 'c', null]);
      expect(diff.planLayout()).toEqual(['a', 'b', 'c', 'd']);
      diff.end();
      expect(layout.toJSON()).toEqual(before);
    });
  });

  describe('差分結果の表示', () => {
    it('追加・削除・変更を、行番号付きの統一差分で表示する', () => {
      addTab('x', 'timeout=30\nretry=3\ndebug=false');
      addTab('y', 'timeout=60\nretry=3\ndebug=true\ncache=true');
      layout.load({ count: 3, tabs: ['x', 'y', null], active: 0 }, order(), true);
      syncPanes();
      begin();
      expect(lines(hosts[2])).toEqual([
        '@@ -1,1 +1,1 @@',
        '- timeout=30',
        '+ timeout=60',
        '',
        '@@ -3,1 +3,2 @@',
        '- debug=false',
        '+ debug=true',
        '+ cache=true',
      ]);
      expect(marked(hosts[2], 'cm-diff-r-del')).toBe(2);
      expect(marked(hosts[2], 'cm-diff-r-add')).toBe(3);
      expect(marked(hosts[2], 'cm-diff-hunk')).toBe(2);
      // 行番号（比較元・比較先）を 2 つのガターに表示する
      const gutters = hosts[2].querySelectorAll('.cm-diff-gutter');
      expect(gutters).toHaveLength(2);
      expect(gutters[0].textContent).toContain('3');
      // 比較元・比較先のペインにも差分を表示する
      expect(marked(hosts[0], 'cm-diff-chg')).toBe(2);
      expect(marked(hosts[1], 'cm-diff-chg')).toBe(3);
    });

    it('内容が同じ場合は「差分はありません」と表示する', () => {
      editor.applyToTab('c', (s) => ({ changes: { from: 0, to: s.doc.length, insert: 'one\ntwo\nthree' } }));
      layout.load({ count: 3, tabs: ['a', 'c', null], active: 0 }, order(), true);
      syncPanes();
      begin();
      expect(diff.status).toMatchObject({ total: 0, current: -1 });
      expect(lines(hosts[2])).toEqual(['差分はありません']);
      expect(noDiffMarks(hosts[0])).toBe(true);
      diff.next();
      diff.previous();
      expect(diff.status?.current).toBe(-1);
    });

    it('空文書どうし、空文書との比較も扱える', () => {
      addTab('e1', '');
      addTab('e2', '');
      layout.load({ count: 3, tabs: ['e1', 'e2', null], active: 0 }, order(), true);
      syncPanes();
      begin();
      expect(lines(hosts[2])).toEqual(['差分はありません']);
      diff.end();
      layout.load({ count: 3, tabs: ['e1', 'a', null], active: 0 }, order(), true);
      syncPanes();
      begin();
      expect(lines(hosts[2])).toEqual(['@@ -0,0 +1,3 @@', '+ one', '+ two', '+ three']);
    });

    it('日本語のテキストを比較できる', () => {
      addTab('ja1', 'こんにちは世界\nさようなら');
      addTab('ja2', 'こんばんは世界\nさようなら');
      layout.load({ count: 3, tabs: ['ja1', 'ja2', null], active: 0 }, order(), true);
      syncPanes();
      begin();
      expect(lines(hosts[2])).toEqual(['@@ -1,1 +1,1 @@', '- こんにちは世界', '+ こんばんは世界']);
      expect(hosts[2].querySelectorAll('.cm-diff-text-del, .cm-diff-text-add').length).toBeGreaterThan(0);
    });

    it('結果表示は読み取り専用で、ペイン見出しに結果であることが分かる属性を持つ', () => {
      begin();
      editor.setActivePane(2);
      expect(editor.view.state.readOnly).toBe(true);
      expect(hosts[2].querySelector('.cm-content')?.getAttribute('aria-label')).toBe('差分結果（読み取り専用）');
    });
  });

  describe('差分のナビゲーション', () => {
    it('前後に移動し（端で折り返す）、選択中の差分を結果表示・比較元・比較先で強調する', () => {
      begin();
      expect(diff.status?.current).toBe(0);
      expect(marked(hosts[2], 'cm-diff-current')).toBe(3); // 見出し + - + +
      expect(marked(hosts[0], 'cm-diff-current')).toBe(1);
      diff.next();
      expect(diff.status?.current).toBe(1);
      expect(marked(hosts[2], 'cm-diff-current')).toBe(2); // 見出し + +
      expect(hosts[2].querySelector('.cm-diff-current')?.textContent).toBe('@@ -3,0 +4,1 @@');
      diff.next();
      expect(diff.status?.current).toBe(0);
      diff.previous();
      expect(diff.status?.current).toBe(1);
      diff.previous();
      expect(diff.status?.current).toBe(0);
    });

    it('結果の差分を選ぶ（クリック相当）と、比較元・比較先の対応する位置を表示する', () => {
      const reveal = vi.spyOn(editor, 'revealLine');
      begin();
      reveal.mockClear();
      diff.goTo(1, false);
      expect(diff.status?.current).toBe(1);
      expect(reveal).toHaveBeenCalledWith('a', 4);
      expect(reveal).toHaveBeenCalledWith('b', 4);
    });
  });

  describe('編集への追従', () => {
    it('比較元・比較先を編集すると、差分結果を少し遅れて更新する（Undo/Redo の履歴も保持する）', () => {
      begin();
      expect(diff.status?.total).toBe(2);
      editor.setActivePane(1);
      editor.view.dispatch({ changes: { from: 4, to: 5, insert: 'two' }, userEvent: 'input.type' });
      // 入力のたびには再計算しない
      expect(diff.status?.total).toBe(2);
      vi.advanceTimersByTime(2000);
      expect(diff.status).toMatchObject({ total: 1, added: 1, changed: 0 });
      expect(lines(hosts[2])).toEqual(['@@ -3,0 +4,1 @@', '+ four']);

      expect(undo(editor.view)).toBe(true);
      expect(editor.getContent('b')).toBe('one\n2\nthree\nfour');
      vi.advanceTimersByTime(2000);
      expect(diff.status?.total).toBe(2);
      expect(redo(editor.view)).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(diff.status?.total).toBe(1);

      // 比較を終了しても編集内容と履歴は残り、結果の更新が本文を変えることもない
      diff.end();
      expect(editor.getContent('b')).toBe('one\ntwo\nthree\nfour');
      expect(editor.getContent('a')).toBe('one\ntwo\nthree');
      layout.show('b', 0, true);
      expect(undo(editor.view)).toBe(true);
      expect(editor.getContent('b')).toBe('one\n2\nthree\nfour');
    });

    it('差分表示・結果の更新は、本文の変更履歴に入らない', () => {
      editor.applyToTab('a', (s) => ({ changes: { from: s.doc.length, insert: '!' }, userEvent: 'input.type' }));
      begin();
      diff.next();
      vi.advanceTimersByTime(2000);
      diff.end();
      expect(editor.getContent('a')).toBe('one\ntwo\nthree!');
      expect(undo(editor.view)).toBe(true);
      expect(editor.getContent('a')).toBe('one\ntwo\nthree');
      expect(undo(editor.view)).toBe(false);
    });

    it('結果表示は、比較終了後に再計算のタイマーが動かない', () => {
      begin();
      editor.applyToTab('a', (s) => ({ changes: { from: s.doc.length, insert: 'x' } }));
      diff.end();
      vi.advanceTimersByTime(5000);
      expect(noDiffMarks(hosts[0])).toBe(true);
      expect(diff.status).toBeNull();
    });

    it('日本語を含む大きめのファイルでも比較できる', () => {
      const big = Array.from({ length: 20000 }, (_, i) => `行${i}：これは日本語のテキストです。`);
      const edited = [...big];
      edited[100] = '行100：変更された日本語のテキストです。';
      edited.splice(15000, 1);
      editor.applyToTab('c', (s) => ({ changes: { from: 0, to: s.doc.length, insert: big.join('\n') } }));
      editor.applyToTab('d', (s) => ({ changes: { from: 0, to: s.doc.length, insert: edited.join('\n') } }));
      layout.load({ count: 3, tabs: ['c', 'd', null], active: 0 }, order(), true);
      syncPanes();
      const t0 = performance.now();
      begin();
      expect(performance.now() - t0).toBeLessThan(3000);
      expect(diff.status).toMatchObject({ total: 2, changed: 1, deleted: 1 });
    });
  });

  describe('書き出し用のスナップショット', () => {
    it('比較前・終了後には結果がなく、比較方向と最新の名前で独立した値を返す', () => {
      expect(diff.snapshotForExport()).toBeNull();
      begin({ a: 1, b: 0, result: 2 });
      store.update('b', { name: '変更後の名前.txt' });
      const snapshot = diff.snapshotForExport()!;
      expect(snapshot.a).toEqual({ name: '変更後の名前.txt', pane: 1, tabNumber: 2 });
      expect(snapshot.b).toEqual({ name: 'a.txt', pane: 0, tabNumber: 1 });
      expect(snapshot.text).toContain('- 2\n+ two');
      diff.next();
      const status = diff.status;
      expect(diff.snapshotForExport()!.text).toBe(snapshot.text);
      expect(diff.status).toEqual(status);
      diff.end();
      expect(diff.snapshotForExport()).toBeNull();
      expect(snapshot.text).toContain('- four');
    });

    it('再計算待ちの最新編集を反映し、本文・未書き出し状態・配置・Undo/Redo を維持する', () => {
      begin();
      editor.setActivePane(1);
      editor.view.dispatch({ changes: { from: 4, to: 5, insert: 'two' }, userEvent: 'input.type' });
      const meta = store.all.map((t) => ({ ...t }));
      const layoutBefore = layout.toJSON();
      expect(diff.status?.total).toBe(2);
      const snapshot = diff.snapshotForExport()!;
      expect(snapshot.text).toBe('@@ -3,0 +4,1 @@\n+ four');
      expect(lines(hosts[2])).toEqual(snapshot.text.split('\n'));
      expect(store.all).toEqual(meta);
      expect(layout.toJSON()).toEqual(layoutBefore);
      expect(editor.getContent('a')).toBe('one\ntwo\nthree');
      expect(editor.getContent('b')).toBe('one\ntwo\nthree\nfour');
      const changed = vi.fn();
      diff.events.on('change', changed);
      vi.advanceTimersByTime(2000);
      expect(changed).not.toHaveBeenCalled();
      expect(undo(editor.view)).toBe(true);
      expect(editor.getContent('b')).toBe('one\n2\nthree\nfour');
      expect(redo(editor.view)).toBe(true);
      expect(editor.getContent('b')).toBe('one\ntwo\nthree\nfour');
      expect(snapshot.text).toBe('@@ -3,0 +4,1 @@\n+ four');
    });
  });

  describe('比較を続けられない操作', () => {
    const closeTab = (id: string) => {
      const index = store.indexOf(id);
      store.remove(id);
      editor.removeTab(id);
      layout.removeTab(id, order(), index);
    };

    it('比較中のタブが閉じられたら、安全に終了し、結果表示のペインを元のタブに戻す', () => {
      layout.load({ count: 3, tabs: ['a', 'b', 'c'], active: 0 }, order(), true);
      syncPanes();
      begin({ a: 0, b: 1, result: 2 });
      closeTab('b');
      expect(diff.active).toBe(false);
      expect(notices.join()).toContain('閉じられた');
      expect(editor.hasOverlay(2)).toBe(false);
      // 閉じたタブのペインには近くのタブが表示される。結果表示のペインは元のタブに戻る（重複して表示しない）
      const shown = layout.tabs.filter((id) => id !== null);
      expect(new Set(shown).size).toBe(shown.length);
      expect(shown).toContain('c');
      expect(noDiffMarks(hosts[0])).toBe(true);
      expect(editor.getContent('a')).toBe('one\ntwo\nthree');
    });

    it('比較元のペインの表示が変わったら終了する', () => {
      begin();
      layout.show('c', 0, true);
      expect(diff.active).toBe(false);
      expect(notices.join()).toContain('表示が変わった');
      expect(editor.hasOverlay(2)).toBe(false);
    });

    it('比較中のタブが閉じられても、結果表示のペインが空のままなら、元のタブを戻す', () => {
      layout.load({ count: 3, tabs: ['a', 'b', 'c'], active: 0 }, order(), true);
      syncPanes();
      begin({ a: 0, b: 1, result: 2 });
      closeTab('a');
      expect(diff.active).toBe(false);
      expect(layout.tabs[2] === 'c' || layout.tabs.includes('c')).toBe(true);
      expect(editor.hasOverlay(2)).toBe(false);
    });

    it('結果表示のペインにタブが表示されたら、そのタブを優先して終了する（元のタブで上書きしない）', () => {
      layout.load({ count: 3, tabs: ['a', 'b', 'c'], active: 0 }, order(), true);
      syncPanes();
      begin({ a: 0, b: 1, result: 2 });
      layout.show('d', 2, true);
      expect(diff.active).toBe(false);
      expect(layout.tabs).toEqual(['a', 'b', 'd']);
      expect(editor.hasOverlay(2)).toBe(false);
      expect(hosts[2].querySelector('.cm-content')?.textContent).toBe('dddd');
      expect(editor.getContent('c')).toBe('unrelated');
    });

    it('分割数を減らして結果表示のペインがなくなったら終了する', () => {
      begin();
      layout.setCount(2, order());
      expect(diff.active).toBe(false);
      expect(editor.hasOverlay(2)).toBe(false);
    });

    it('アクティブなペインの切り替えや、比較に使わないペインの操作では終了しない', () => {
      layout.load({ count: 4, tabs: ['a', 'b', null, 'd'], active: 0 }, order(), true);
      syncPanes();
      begin({ a: 0, b: 1, result: 2 });
      layout.setActive(2);
      layout.setActive(3);
      layout.show('c', 3, true);
      expect(diff.active).toBe(true);
      expect(notices).toEqual([]);
    });

    it('比較に使っていないタブが閉じられても比較を続け、終了時は現在の表示で補う', () => {
      layout.load({ count: 4, tabs: ['a', 'b', null, 'c'], active: 0 }, order(), true);
      syncPanes();
      begin({ a: 0, b: 1, result: 2 });
      closeTab('c');
      expect(diff.active).toBe(true);
      diff.end();
      expect(layout.tabs.slice(0, 2)).toEqual(['a', 'b']);
      expect(new Set(layout.tabs.filter((id) => id)).size).toBe(layout.tabs.filter((id) => id).length);
    });

    it('タブをすべて入れ替える操作（バックアップ復元）では、比較を終了できる', () => {
      begin();
      editor.clear();
      diff.end(false);
      expect(diff.active).toBe(false);
      expect(editor.hasOverlay(2)).toBe(false);
      expect(notices).toEqual([]);
    });
  });

  describe('保存', () => {
    it('比較中の保存用の配置には、結果表示のために外したタブを元のペインに戻して含める', () => {
      layout.load({ count: 3, tabs: ['a', 'b', 'c'], active: 0 }, order(), true);
      syncPanes();
      begin({ a: 0, b: 1, result: 2 });
      expect(layout.tabs[2]).toBeNull();
      expect(diff.layoutForSave()).toEqual({ count: 3, tabs: ['a', 'b', 'c'], active: 0 });
      diff.end();
      expect(diff.layoutForSave()).toEqual(layout.toJSON());
    });

    it('結果表示がタブとして登録されることはない', () => {
      begin();
      expect(store.all.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
      expect(layout.tabs.filter((t) => t !== null && !store.get(t))).toEqual([]);
    });
  });

  it('比較の通知を購読できる', () => {
    const totals: (number | undefined)[] = [];
    diff.events.on('change', () => totals.push(diff.status?.total));
    begin();
    diff.end();
    expect(totals.at(0)).toBe(2);
    expect(totals.at(-1)).toBeUndefined();
  });
});
