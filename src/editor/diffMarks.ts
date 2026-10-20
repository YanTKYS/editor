import { type Extension, type Range, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import type { DiffResult } from '../core/diff';

/** 差分の強調表示。各タブの EditorState に持たせるため、ペインやタブを切り替えても維持される。 */
export const setDiffMarks = StateEffect.define<DecorationSet>();

export const diffMarksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    // 編集中は位置だけ追従させ、正確な再計算は DiffController が少し遅れて行う
    if (tr.docChanged) value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setDiffMarks)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 本文・Undo 履歴・選択範囲に影響しない、差分の強調表示を設定する効果 */
export function diffMarksSpec(marks: DecorationSet) {
  return { effects: setDiffMarks.of(marks), annotations: Transaction.addToHistory.of(false) };
}

export const diffExtension: Extension = diffMarksField;

export type DiffSide = 'a' | 'b';

const lineDeco = (cls: string) => Decoration.line({ class: cls });

/**
 * 差分の強調表示を作る。
 * - 行の背景: 追加（B 側）・削除（A 側）・変更（両側）
 * - 変更行は、行内の異なる文字も強調
 * - 相手側にだけ行がある位置には、境界線を表示
 * @param current 現在の差分（前後移動で選択中のもの）。-1 なら該当なし
 */
export function buildDiffMarks(result: DiffResult, side: DiffSide, doc: Text, current: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const own = side === 'a' ? 'del' : 'add';
  result.blocks.forEach((blk, index) => {
    const start = side === 'a' ? blk.startLineA : blk.startLineB;
    const end = side === 'a' ? blk.endLineA : blk.endLineB;
    const cur = index === current ? ' cm-diff-current' : '';
    if (start === end) {
      // この側には行がない: 相手側にだけある行の位置を境界線で示す
      if (doc.lines === 0) return;
      const where = start > doc.lines ? 'after' : 'before';
      const line = doc.line(Math.min(start, doc.lines));
      ranges.push(lineDeco(`cm-diff-gap-${where}${cur}`).range(line.from));
      return;
    }
    const cls = blk.kind === 'chg' ? 'cm-diff-chg' : `cm-diff-${own}`;
    for (let n = start; n < end && n <= doc.lines; n++) {
      ranges.push(lineDeco(`${cls}${cur}`).range(doc.line(n).from));
    }
    const mark = Decoration.mark({ class: side === 'a' ? 'cm-diff-text-del' : 'cm-diff-text-add' });
    for (const c of blk.inline) {
      const from = side === 'a' ? c.fromA : c.fromB;
      const to = side === 'a' ? c.toA : c.toB;
      if (to > from && to <= doc.length) ranges.push(mark.range(from, to));
    }
  });
  return Decoration.set(ranges, true);
}
