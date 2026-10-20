import { undo } from '@codemirror/commands';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQuery, EMPTY_SEARCH } from '../../src/core/search';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import { EditorManager } from '../../src/editor/editorManager';
import { searchActiveField } from '../../src/editor/visualize';

describe('EditorManager', () => {
  let hosts: HTMLElement[];
  let mgr: EditorManager;
  let changed: string[];

  beforeEach(() => {
    hosts = [0, 1, 2, 3].map(() => {
      const el = document.createElement('div');
      document.body.append(el);
      return el;
    });
    changed = [];
    mgr = new EditorManager({ ...DEFAULT_SETTINGS }, {
      onDocChange: (id) => changed.push(id),
      onCursorActivity: () => {},
    });
    mgr.attachPane(0, hosts[0]);
    mgr.addTab('a', 'plaintext', 'LF', 'A');
    mgr.addTab('b', 'plaintext', 'CRLF', 'B');
  });

  afterEach(() => {
    for (const el of hosts) el.remove();
  });

  /** アクティブなペインに表示する（1 画面での「タブの切り替え」） */
  const show = (id: string) => mgr.showInPane(mgr.activePaneIndex, id);

  const type = (text: string) => {
    const end = mgr.view.state.doc.length;
    mgr.view.dispatch({ changes: { from: end, insert: text }, userEvent: 'input.type' });
  };

  it('タブを切り替えても本文と Undo 履歴を維持する', () => {
    show('a');
    type('1');
    show('b');
    type('2');
    expect(mgr.getContent('a')).toBe('A1');
    expect(mgr.getContent('b')).toBe('B2');
    show('a');
    expect(undo(mgr.view)).toBe(true);
    expect(mgr.getContent('a')).toBe('A');
    expect(mgr.getContent('b')).toBe('B2');
    show('b');
    expect(undo(mgr.view)).toBe(true);
    expect(mgr.getContent('b')).toBe('B');
    expect(changed).toEqual(['a', 'b', 'a', 'b']);
  });

  it('選択範囲を復元する', () => {
    mgr.addTab('c', 'plaintext', 'LF', 'hello world', { selection: { ranges: [{ anchor: 6, head: 11 }], main: 0 } });
    show('c');
    expect(mgr.view.state.selection.main).toMatchObject({ from: 6, to: 11 });
    // 本文より大きい位置は切り詰める
    mgr.addTab('d', 'plaintext', 'LF', 'ab', { selection: { ranges: [{ anchor: 99, head: 99 }], main: 0 } });
    show('d');
    expect(mgr.view.state.selection.main.head).toBe(2);
  });

  it('非表示のタブにも変更を適用でき、その履歴で元に戻せる', () => {
    show('a');
    mgr.applyToTab('b', (s) => ({ changes: { from: 0, to: s.doc.length, insert: 'replaced' } }));
    expect(mgr.getContent('b')).toBe('replaced');
    expect(changed).toEqual(['b']);
    show('b');
    undo(mgr.view);
    expect(mgr.getContent('b')).toBe('B');
  });

  it('未表示のタブは EditorState を作らずに検索用の本文を返す', () => {
    expect(mgr.getSearchSource('b')).toBe('B');
    show('b');
    expect(typeof mgr.getSearchSource('b')).toBe('object');
  });

  it('設定変更を非表示のタブにも反映する', () => {
    show('a');
    show('b');
    mgr.applySettings({ ...DEFAULT_SETTINGS, tabSize: 8 });
    expect(mgr.view.state.tabSize).toBe(8);
    show('a');
    expect(mgr.view.state.tabSize).toBe(8);
  });

  it('タブを削除すると表示していたペインは空になる', () => {
    show('a');
    mgr.removeTab('a');
    expect(mgr.hasTab('a')).toBe(false);
    expect(mgr.activeTabId).toBeNull();
    expect(mgr.view.state.doc.length).toBe(0);
  });

  describe('複数ペイン', () => {
    beforeEach(() => {
      mgr.attachPane(1, hosts[1]);
      mgr.showInPane(0, 'a');
      mgr.showInPane(1, 'b');
    });

    it('ペインごとに別のタブを表示・編集できる', () => {
      expect(hosts[0].querySelector('.cm-content')?.textContent).toBe('A');
      expect(hosts[1].querySelector('.cm-content')?.textContent).toBe('B');
      mgr.setActivePane(1);
      expect(mgr.activeTabId).toBe('b');
      type('2');
      mgr.setActivePane(0);
      type('1');
      expect(mgr.getContent('a')).toBe('A1');
      expect(mgr.getContent('b')).toBe('B2');
      expect(mgr.paneOfTab('b')).toBe(1);
    });

    it('別のペインへ移したタブは元のペインから外れ、履歴を引き継ぐ', () => {
      mgr.setActivePane(1);
      type('2');
      mgr.showInPane(0, 'b');
      expect(mgr.paneOfTab('b')).toBe(0);
      expect(hosts[1].querySelector('.cm-content')?.textContent).toBe('');
      mgr.setActivePane(0);
      expect(undo(mgr.view)).toBe(true);
      expect(mgr.getContent('b')).toBe('B');
      // 移動前に表示していた a は失われない
      expect(mgr.getContent('a')).toBe('A');
    });

    it('ペインを閉じても（空にしても）タブの本文と履歴は残る', () => {
      mgr.setActivePane(1);
      type('2');
      mgr.showInPane(1, null);
      expect(mgr.paneOfTab('b')).toBe(-1);
      expect(mgr.getContent('b')).toBe('B2');
      mgr.showInPane(0, 'b');
      mgr.setActivePane(0);
      expect(undo(mgr.view)).toBe(true);
      expect(mgr.getContent('b')).toBe('B');
    });

    it('表示中のタブへの選択はそのペインで行う', () => {
      mgr.select('b', 0, 1);
      mgr.setActivePane(1);
      expect(mgr.view.state.selection.main).toMatchObject({ from: 0, to: 1 });
    });

    it('検索の強調表示はアクティブなペインだけに出す', () => {
      const query = createQuery({ ...EMPTY_SEARCH, search: 'A' });
      mgr.setSearch(query, true);
      const field = (pane: number) => {
        mgr.setActivePane(pane);
        return mgr.view.state.field(searchActiveField);
      };
      expect(mgr.view.state.field(searchActiveField)).toBe(true);
      mgr.setActivePane(1);
      expect(field(1)).toBe(true);
      mgr.setActivePane(0);
      expect(mgr.getState('b')?.field(searchActiveField)).toBe(false);
    });
  });
});
