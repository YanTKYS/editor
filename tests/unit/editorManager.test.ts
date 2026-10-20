import { undo } from '@codemirror/commands';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import { EditorManager } from '../../src/editor/editorManager';

describe('EditorManager', () => {
  let host: HTMLElement;
  let mgr: EditorManager;
  let changed: string[];

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    changed = [];
    mgr = new EditorManager(host, { ...DEFAULT_SETTINGS }, {
      onDocChange: (id) => changed.push(id),
      onCursorActivity: () => {},
    });
    mgr.addTab('a', 'plaintext', 'LF', 'A');
    mgr.addTab('b', 'plaintext', 'CRLF', 'B');
  });

  afterEach(() => {
    mgr.view.destroy();
    host.remove();
  });

  const type = (text: string) => {
    const end = mgr.view.state.doc.length;
    mgr.view.dispatch({ changes: { from: end, insert: text }, userEvent: 'input.type' });
  };

  it('タブを切り替えても本文と Undo 履歴を維持する', () => {
    mgr.activate('a');
    type('1');
    mgr.activate('b');
    type('2');
    expect(mgr.getContent('a')).toBe('A1');
    expect(mgr.getContent('b')).toBe('B2');
    mgr.activate('a');
    expect(undo(mgr.view)).toBe(true);
    expect(mgr.getContent('a')).toBe('A');
    expect(mgr.getContent('b')).toBe('B2');
    mgr.activate('b');
    expect(undo(mgr.view)).toBe(true);
    expect(mgr.getContent('b')).toBe('B');
    expect(changed).toEqual(['a', 'b', 'a', 'b']);
  });

  it('選択範囲を復元する', () => {
    mgr.addTab('c', 'plaintext', 'LF', 'hello world', { selection: { ranges: [{ anchor: 6, head: 11 }], main: 0 } });
    mgr.activate('c');
    expect(mgr.view.state.selection.main).toMatchObject({ from: 6, to: 11 });
    // 本文より大きい位置は切り詰める
    mgr.addTab('d', 'plaintext', 'LF', 'ab', { selection: { ranges: [{ anchor: 99, head: 99 }], main: 0 } });
    mgr.activate('d');
    expect(mgr.view.state.selection.main.head).toBe(2);
  });

  it('非アクティブのタブにも変更を適用でき、その履歴で元に戻せる', () => {
    mgr.activate('a');
    mgr.applyToTab('b', (s) => ({ changes: { from: 0, to: s.doc.length, insert: 'replaced' } }));
    expect(mgr.getContent('b')).toBe('replaced');
    expect(changed).toEqual(['b']);
    mgr.activate('b');
    undo(mgr.view);
    expect(mgr.getContent('b')).toBe('B');
  });

  it('未表示のタブは EditorState を作らずに検索用の本文を返す', () => {
    expect(mgr.getSearchSource('b')).toBe('B');
    mgr.activate('b');
    expect(typeof mgr.getSearchSource('b')).toBe('object');
  });

  it('設定変更を非表示のタブにも反映する', () => {
    mgr.activate('a');
    mgr.activate('b');
    mgr.applySettings({ ...DEFAULT_SETTINGS, tabSize: 8 });
    expect(mgr.view.state.tabSize).toBe(8);
    mgr.activate('a');
    expect(mgr.view.state.tabSize).toBe(8);
  });

  it('タブを削除する', () => {
    mgr.activate('a');
    mgr.removeTab('a');
    expect(mgr.hasTab('a')).toBe(false);
    expect(mgr.activeTabId).toBeNull();
  });
});
