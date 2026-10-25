import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { computeDiff, formatUnified } from '../../src/core/diff';
import { diffExportFileName, formatDiffExport, type DiffExportSnapshot } from '../../src/files/diffExport';

const now = new Date('2026-10-25T12:34:56.789Z');
function snapshot(before: string, after: string): DiffExportSnapshot {
  const a = Text.of(before.split('\n'));
  const b = Text.of(after.split('\n'));
  const summary = computeDiff(a, b);
  return {
    a: { name: '設定.txt', pane: 0, tabNumber: 2 },
    b: { name: '設定.txt', pane: 1, tabNumber: 3 },
    summary,
    text: formatUnified(summary, a, b).text,
  };
}

describe('差分の記録用テキスト', () => {
  it('同名タブの方向・位置・出力日時と、表示されるすべての差分を記録する', () => {
    const s = snapshot('先頭\n変更前\n共通\n削除', '先頭\n変更後\n共通\n追加\n');
    const text = formatDiffExport(s, now);
    expect(text).toContain('出力日時（UTC）: 2026-10-25T12:34:56.789Z');
    expect(text).toContain('比較元（変更前）: "設定.txt"（ペイン 1・タブ 2）');
    expect(text).toContain('比較先（変更後）: "設定.txt"（ペイン 2・タブ 3）');
    expect(text).toContain('比較方向: 比較元（変更前） → 比較先（変更後）');
    expect(text).toContain('適用可能なパッチ形式は保証しません');
    expect(text.endsWith(`\n\n${s.text}\n`)).toBe(true);
    expect(text).toContain('- 変更前\n+ 変更後');
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\uFEFF');
    expect(text).toContain('改行コード設定・BOM の違いは比較対象外');
    expect(diffExportFileName(now)).toBe('diff-20261025T123456789Z.txt');
  });

  it.each(['', '同じ内容\n'])('同一内容・空文書でも差分なしを記録する (%j)', (content) => {
    const text = formatDiffExport(snapshot(content, content), now);
    expect(text).toContain('差分 0 件（追加 0・削除 0・変更 0）');
    expect(text).toContain('通常比較');
    expect(text).toMatch(/\n\n差分はありません\n$/);
  });

  it('簡易比較であることと、差分本文・件数を記録する', () => {
    const s = snapshot('', '追加\n');
    s.summary.precise = false;
    const text = formatDiffExport(s, now);
    expect(text).toContain('簡易比較（大きな差分のため');
    expect(text).toContain('差分 1 件（追加 1・削除 0・変更 0）');
    expect(text.endsWith(`${s.text}\n`)).toBe(true);
  });

  it('改行・引用符・タブなどを含む名前でヘッダー行を壊さない', () => {
    const s = snapshot('前', '後');
    s.a.name = '"前"\r\n比較先:偽\t\\.txt';
    const line = formatDiffExport(s, now).split('\n')[2];
    expect(line).toBe(`比較元（変更前）: ${JSON.stringify(s.a.name)}（ペイン 1・タブ 2）`);
  });
});
