import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, gutter, GutterMarker } from '@codemirror/view';
import type { UnifiedDiff } from '../core/diff';

/** 差分結果を表示する読み取り専用ビュー（一時的なもので、タブとしては扱わない）の拡張 */

const setUnified = StateEffect.define<UnifiedDiff>();
const setCurrentBlock = StateEffect.define<number>();

interface ResultModel {
  diff: UnifiedDiff;
  /** 差分の背景・行内の強調 */
  base: DecorationSet;
  /** 選択中の差分 */
  current: DecorationSet;
}

const LINE_CLASS = {
  hunk: 'cm-diff-hunk',
  del: 'cm-diff-r-del',
  add: 'cm-diff-r-add',
  blank: 'cm-diff-r-blank',
  note: 'cm-diff-r-note',
} as const;

const textDel = Decoration.mark({ class: 'cm-diff-text-del' });
const textAdd = Decoration.mark({ class: 'cm-diff-text-add' });
const signMark = Decoration.mark({ class: 'cm-diff-sign' });
const currentLine = Decoration.line({ class: 'cm-diff-current' });

function buildBase(diff: UnifiedDiff, state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  diff.lines.forEach((l, i) => {
    if (i >= doc.lines) return;
    const line = doc.line(i + 1);
    ranges.push(Decoration.line({ class: LINE_CLASS[l.kind] }).range(line.from));
    if (l.prefix) ranges.push(signMark.range(line.from, line.from + 1));
    const mark = l.kind === 'del' ? textDel : textAdd;
    for (const [from, to] of l.marks) ranges.push(mark.range(line.from + l.prefix.length + from, line.from + l.prefix.length + to));
  });
  return Decoration.set(ranges, true);
}

function buildCurrent(diff: UnifiedDiff, state: EditorState, index: number): DecorationSet {
  const blk = diff.blocks[index];
  if (!blk) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (let i = blk.first; i <= blk.last && i < state.doc.lines; i++) {
    ranges.push(currentLine.range(state.doc.line(i + 1).from));
  }
  return Decoration.set(ranges, true);
}

class NumberMarker extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: NumberMarker): boolean {
    return other.text === this.text;
  }
  override toDOM(): Node {
    return document.createTextNode(this.text);
  }
}

/**
 * 差分結果ビューの拡張。
 * - 本文は差分のある箇所だけの統一差分形式（- 削除 / + 追加）で、読み取り専用
 * - 比較元・比較先の行番号を 2 列のガターに表示
 * - 行をクリックすると、その差分を選択する（onSelectBlock）
 */
export function resultExtensions(initial: UnifiedDiff, onSelectBlock: (block: number) => void): Extension {
  const field = StateField.define<ResultModel>({
    create: (state) => ({ diff: initial, base: buildBase(initial, state), current: Decoration.none }),
    update(value, tr) {
      let { diff, base, current } = value;
      let rebuilt = false;
      let index: number | undefined;
      for (const e of tr.effects) {
        if (e.is(setUnified)) {
          diff = e.value;
          rebuilt = true;
        } else if (e.is(setCurrentBlock)) {
          index = e.value;
        }
      }
      if (rebuilt) base = buildBase(diff, tr.state);
      else if (tr.docChanged) base = base.map(tr.changes);
      if (index !== undefined) current = buildCurrent(diff, tr.state, index);
      else if (rebuilt) current = Decoration.none;
      else if (tr.docChanged) current = current.map(tr.changes);
      return { diff, base, current };
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.base),
      EditorView.decorations.from(f, (v) => v.current),
    ],
  });

  const blockAt = (state: EditorState, pos: number): number => {
    const model = state.field(field);
    return model.diff.lines[state.doc.lineAt(pos).number - 1]?.block ?? -1;
  };

  const digits = Math.max(
    4,
    String(initial.lines.reduce((max, l) => Math.max(max, l.oldNo ?? 0, l.newNo ?? 0), 0)).length,
  );
  const numberGutter = (side: 'oldNo' | 'newNo') =>
    gutter({
      class: `cm-diff-gutter cm-diff-gutter-${side}`,
      lineMarker(view, line) {
        const no = view.state.field(field).diff.lines[view.state.doc.lineAt(line.from).number - 1]?.[side];
        return no ? new NumberMarker(String(no)) : null;
      },
      lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setUnified))),
      initialSpacer: () => new NumberMarker('0'.repeat(digits)),
      domEventHandlers: {
        mousedown(view, line) {
          const block = blockAt(view.state, line.from);
          if (block >= 0) onSelectBlock(block);
          return false;
        },
      },
    });

  return [
    field,
    numberGutter('oldNo'),
    numberGutter('newNo'),
    EditorView.contentAttributes.of({ 'aria-label': '差分結果（読み取り専用）', spellcheck: 'false' }),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const block = pos === null ? -1 : blockAt(view.state, pos);
        if (block >= 0) onSelectBlock(block);
        return false;
      },
    }),
  ];
}

/** 本文を差分結果に更新する（変更箇所だけを置き換え、スクロール位置を保つ）。履歴には残さない */
export function unifiedSpec(state: EditorState, diff: UnifiedDiff, current: number): TransactionSpec {
  const oldText = state.doc.toString();
  const text = diff.text;
  let start = 0;
  const max = Math.min(oldText.length, text.length);
  while (start < max && oldText.charCodeAt(start) === text.charCodeAt(start)) start++;
  let endOld = oldText.length;
  let endNew = text.length;
  while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  return {
    changes: start === endOld && start === endNew ? undefined : { from: start, to: endOld, insert: text.slice(start, endNew) },
    effects: [setUnified.of(diff), setCurrentBlock.of(current)],
    annotations: Transaction.addToHistory.of(false),
  };
}

/** 選択中の差分を変更する。scroll = true なら、その差分が見える位置へスクロールする */
export function currentSpec(state: EditorState, diff: UnifiedDiff, index: number, scroll: boolean): TransactionSpec {
  const effects: StateEffect<unknown>[] = [setCurrentBlock.of(index)];
  const blk = diff.blocks[index];
  if (scroll && blk && blk.first < state.doc.lines) {
    effects.push(EditorView.scrollIntoView(state.doc.line(blk.first + 1).from, { y: 'start', yMargin: 8 }));
  }
  return { effects, annotations: Transaction.addToHistory.of(false) };
}
