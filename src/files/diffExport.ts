import type { DiffResult } from '../core/diff';

/** 同じ時点の比較対象・集計・表示本文をまとめた、書き出し用の値 */
export interface DiffExportSnapshot {
  a: { name: string; pane: number; tabNumber: number };
  b: { name: string; pane: number; tabNumber: number };
  summary: Pick<DiffResult, 'added' | 'deleted' | 'changed' | 'precise'>;
  text: string;
}

/** 閲覧・記録用の差分テキスト。名前中の改行などは引用してヘッダーと区別する */
export function formatDiffExport(snapshot: DiffExportSnapshot, exportedAt: Date): string {
  const { a, b, summary, text } = snapshot;
  const target = (t: typeof a) => `${JSON.stringify(t.name)}（ペイン ${t.pane + 1}・タブ ${t.tabNumber}）`;
  return [
    '差分比較の記録',
    `出力日時（UTC）: ${exportedAt.toISOString()}`,
    `比較元（変更前）: ${target(a)}`,
    `比較先（変更後）: ${target(b)}`,
    '比較方向: 比較元（変更前） → 比較先（変更後）',
    '内容: 出力時点のタブ本文を比較（UTF-8・LF・BOM なし）',
    '改行コード設定・BOM の違いは比較対象外です。',
    `比較方法: ${summary.precise ? '通常比較' : '簡易比較（大きな差分のため、差分の区切りや行内の比較が粗い場合があります）'}`,
    `差分 ${summary.added + summary.deleted + summary.changed} 件（追加 ${summary.added}・削除 ${summary.deleted}・変更 ${summary.changed}）`,
    '閲覧・記録用です。変更のない行は省略し、適用可能なパッチ形式は保証しません。',
    '',
    text,
    '',
  ].join('\n');
}

export function diffExportFileName(exportedAt: Date): string {
  return `diff-${exportedAt.toISOString().replace(/[-:.]/g, '')}.txt`;
}
