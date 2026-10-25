import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { buildReplaceAll, buildReplacePreview, getReplacementExamples, createQuery, EMPTY_SEARCH } from '../../src/core/search';

describe('全タブ置換の確認例', () => {
  it('本文を変更せず、位置と変更前後を実際の正規表現置換と同じ規則で求める', () => {
    const query = createQuery({ ...EMPTY_SEARCH, search: '(id=)(\\d+)', replace: '$2\\n$1$&', regexp: true });
    const state = EditorState.create({ doc: '前の行\nid=12 id=34' });
    const preview = buildReplacePreview(query, state);
    expect(state.doc.toString()).toBe('前の行\nid=12 id=34');
    expect(preview.count).toBe(2);
    expect(preview.examples[0]).toMatchObject({ line: 2, column: 1, before: 'id=12', after: '12\nid=id=12' });
    const result = state.update({ changes: buildReplaceAll(query, state).changes }).state.doc.toString();
    expect(result).toBe('前の行\n12\nid=id=12 34\nid=id=34');
  });

  it('通常検索の置換文字列を解釈せず、削除とゼロ幅の挿入も表現できる', () => {
    const query = createQuery({ ...EMPTY_SEARCH, search: 'a', replace: '$&\\n' });
    expect(buildReplacePreview(query, 'a').examples[0].after).toBe('$&\\n');
    expect(buildReplacePreview(createQuery({ ...EMPTY_SEARCH, search: 'a' }), 'a').examples[0].after).toBe('');
    const insertion = buildReplacePreview(createQuery({ ...EMPTY_SEARCH, search: '^', replace: '頭', regexp: true }), '本文');
    expect(insertion.examples[0]).toMatchObject({ line: 1, column: 1, before: '', after: '頭' });
  });

  it('大量の一致でも件数は正確に数え、確認例だけを制限する', () => {
    const q = createQuery({ ...EMPTY_SEARCH, search: 'x', replace: 'y' });
    expect(buildReplacePreview(q, 'x'.repeat(10000))).toMatchObject({ count: 10000, examples: new Array(5).fill(expect.any(Object)) });
    expect(buildReplacePreview(q, 'xxx', 0)).toEqual({ count: 3, examples: [] });
    expect(buildReplacePreview(q, '一致なし')).toEqual({ count: 0, examples: [] });
  });

  it('ページ用の例だけを上限付きで取得し、従来のプレビューと置換規則を共有する', () => {
    const q = createQuery({ ...EMPTY_SEARCH, search: '(id=)(\\d+)', replace: '$2\\n$1', regexp: true });
    const doc = 'id=12\nid=34\nid=56';
    expect(getReplacementExamples(q, doc, 2)).toEqual(buildReplacePreview(q, doc, 2).examples);
    expect(getReplacementExamples(q, doc, 0)).toEqual([]);
    expect(getReplacementExamples(q, '一致なし')).toEqual([]);
    expect(getReplacementExamples(q, doc, 2)).toHaveLength(2);
  });

  it('長い一致と置換文字列の表示を制限し、改行を含む一致も扱う', () => {
    const q = createQuery({ ...EMPTY_SEARCH, search: 'x+', replace: 'y'.repeat(500), regexp: true });
    const example = buildReplacePreview(q, 'x'.repeat(1000)).examples[0];
    expect(example.before).toBe('x'.repeat(200) + '…');
    expect(example.after).toBe('y'.repeat(200) + '…');
    expect(example.context.length).toBeLessThanOrEqual(90);
    const multi = createQuery({ ...EMPTY_SEARCH, search: 'a\\nb', replace: 'c', regexp: true });
    expect(buildReplacePreview(multi, 'a\nb').examples[0].before).toBe('a\nb');
  });
});
