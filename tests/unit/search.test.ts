import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  buildReplaceAll,
  countMatches,
  createQuery,
  EMPTY_SEARCH,
  findInDocument,
  regexpError,
  type SearchOptions,
} from '../../src/core/search';

const opts = (o: Partial<SearchOptions>): SearchOptions => ({ ...EMPTY_SEARCH, ...o });

function replaceAll(doc: string, o: Partial<SearchOptions>): { text: string; count: number } {
  const state = EditorState.create({ doc });
  const { changes, count } = buildReplaceAll(createQuery(opts(o)), state);
  return { text: state.update({ changes }).state.doc.toString(), count };
}

describe('検索', () => {
  const doc = 'Apple apple APPLE\npineapple\nりんご リンゴ りんご';

  it('大文字小文字を区別しない／する', () => {
    const state = EditorState.create({ doc });
    expect(countMatches(createQuery(opts({ search: 'apple' })), state).total).toBe(4);
    expect(countMatches(createQuery(opts({ search: 'apple', caseSensitive: true })), state).total).toBe(2);
  });

  it('単語単位で検索する', () => {
    const state = EditorState.create({ doc });
    expect(countMatches(createQuery(opts({ search: 'apple', wholeWord: true })), state).total).toBe(3);
  });

  it('日本語を検索できる', () => {
    const state = EditorState.create({ doc });
    expect(countMatches(createQuery(opts({ search: 'りんご' })), state).total).toBe(2);
  });

  it('通常検索ではエスケープを解釈しない', () => {
    const state = EditorState.create({ doc: 'a\\nb\nc' });
    expect(countMatches(createQuery(opts({ search: '\\n' })), state).total).toBe(1);
  });

  it('正規表現で検索する', () => {
    const state = EditorState.create({ doc: 'id=1\nid=22\nname=x' });
    expect(countMatches(createQuery(opts({ search: '^id=\\d+$', regexp: true })), state).total).toBe(2);
  });

  it('不正な正規表現を検出する', () => {
    expect(regexpError(opts({ search: '(abc', regexp: true }))).not.toBeNull();
    expect(regexpError(opts({ search: '(abc', regexp: false }))).toBeNull();
    expect(createQuery(opts({ search: '(abc', regexp: true })).valid).toBe(false);
  });

  it('現在の選択位置が何件目かを返す', () => {
    const state = EditorState.create({ doc: 'x x x', selection: { anchor: 2, head: 3 } });
    expect(countMatches(createQuery(opts({ search: 'x' })), state)).toEqual({ total: 3, capped: false, current: 2 });
  });

  it('件数の上限で打ち切る', () => {
    const state = EditorState.create({ doc: 'a'.repeat(50) });
    expect(countMatches(createQuery(opts({ search: 'a' })), state, 10)).toMatchObject({ total: 10, capped: true });
  });
});

describe('置換', () => {
  it('すべて置換する', () => {
    expect(replaceAll('foo bar foo', { search: 'foo', replace: 'baz' })).toEqual({ text: 'baz bar baz', count: 2 });
  });

  it('通常置換では $ や \\n をそのまま挿入する', () => {
    expect(replaceAll('a-b', { search: '-', replace: '$&\\n' }).text).toBe('a$&\\nb');
  });

  it('正規表現の参照と改行を展開する', () => {
    expect(replaceAll('2024-05-01', { search: '(\\d+)-(\\d+)-(\\d+)', replace: '$3/$2/$1', regexp: true }).text).toBe(
      '01/05/2024',
    );
    expect(replaceAll('a,b,c', { search: ',', replace: '\\n', regexp: true }).text).toBe('a\nb\nc');
    expect(replaceAll('x', { search: 'x', replace: '[$&][$$]', regexp: true }).text).toBe('[x][$]');
  });

  it('大文字小文字を区別して置換する', () => {
    expect(replaceAll('Aa aA', { search: 'a', replace: '_', caseSensitive: true }).text).toBe('A_ _A');
  });
});

describe('横断検索の結果', () => {
  it('行番号・列・前後の文脈を返す', () => {
    const r = findInDocument(createQuery(opts({ search: '検索' })), '一行目\n二行目で検索する\n検索');
    expect(r.total).toBe(2);
    expect(r.matches[0]).toMatchObject({ line: 2, column: 5, preview: '二行目で検索する' });
    const m = r.matches[0];
    expect(m.preview.slice(m.previewFrom, m.previewTo)).toBe('検索');
    expect(r.matches[1]).toMatchObject({ line: 3, column: 1 });
  });

  it('長い行は前後を省略する', () => {
    const line = 'x'.repeat(200) + 'HIT' + 'y'.repeat(200);
    const m = findInDocument(createQuery(opts({ search: 'HIT' })), line).matches[0];
    expect(m.preview.startsWith('…')).toBe(true);
    expect(m.preview.endsWith('…')).toBe(true);
    expect(m.preview.slice(m.previewFrom, m.previewTo)).toBe('HIT');
  });

  it('表示件数を制限しても総数は数える', () => {
    const r = findInDocument(createQuery(opts({ search: 'a' })), 'a\n'.repeat(30), 5);
    expect(r.matches).toHaveLength(5);
    expect(r.total).toBe(30);
  });
});
