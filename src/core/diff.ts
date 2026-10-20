import { Chunk, diff, presentableDiff } from '@codemirror/merge';
import type { Text } from '@codemirror/state';

/** 差分の種類: 追加（B にだけある）・削除（A にだけある）・変更（両方にあるが内容が異なる） */
export type DiffKind = 'add' | 'del' | 'chg';

/** 行内の異なる箇所（文書内オフセット） */
export interface InlineChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/**
 * 行単位の差分 1 件。行番号は 1 始まりで、終了行は含まない（空の範囲は startLine === endLine）。
 * 空の範囲は「その行の手前に、相手側だけにある行がある」ことを表す。
 */
export interface DiffBlock {
  kind: DiffKind;
  startLineA: number;
  endLineA: number;
  startLineB: number;
  endLineB: number;
  /** kind が 'chg' の場合の、行内の異なる箇所 */
  inline: InlineChange[];
}

export interface DiffResult {
  blocks: DiffBlock[];
  added: number;
  deleted: number;
  changed: number;
  /** false の場合、巨大・大差のため簡易な比較に切り替えた（行内の強調などが粗くなる） */
  precise: boolean;
}

/** 巨大な差分でも固まらないよう、詳細な比較を打ち切る条件（打ち切った場合も有効な差分を返す） */
const LINE_DIFF_CONFIG = { scanLimit: 5000, timeout: 600 };
const INLINE_DIFF_CONFIG = { scanLimit: 500, timeout: 150 };
/** 行内の比較を省略する、変更範囲の文字数の上限 */
const INLINE_MAX_CHARS = 20000;
/** 行を 1 文字に置き換えて比較する方法で扱える、異なる行の数の上限（BMP のサロゲート領域を除く） */
const MAX_DISTINCT_LINES = 0xffff - 0x100 - 0x800;

function startLine(doc: Text, from: number): number {
  return doc.lineAt(Math.min(from, doc.length)).number;
}

/** Chunk の終端は「最終行の次の行頭」で、文書末尾の行では文書長を超えることがある */
function endLine(doc: Text, to: number): number {
  return to > doc.length ? doc.lines + 1 : doc.lineAt(to).number;
}

/** 内容の同じ行に同じ 1 文字を割り当てて、文書を「行の列」として文字列にする。異なる行が多すぎれば null */
function encodeLines(docs: readonly Text[]): string[] | null {
  const ids = new Map<string, number>();
  const out: string[] = [];
  for (const doc of docs) {
    const chars: string[] = [];
    for (const line of doc.iterLines()) {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        if (id >= MAX_DISTINCT_LINES) return null;
        ids.set(line, id);
      }
      const code = id + 0x100;
      chars.push(String.fromCharCode(code >= 0xd800 ? code + 0x800 : code));
    }
    out.push(chars.join(''));
  }
  return out;
}

function tally(result: DiffResult, block: DiffBlock): void {
  result.blocks.push(block);
  if (block.kind === 'add') result.added++;
  else if (block.kind === 'del') result.deleted++;
  else result.changed++;
}

function blockKind(startA: number, endA: number, startB: number, endB: number): DiffKind {
  return startA === endA ? 'add' : startB === endB ? 'del' : 'chg';
}

/** 変更ブロックの範囲内で、行内の異なる文字を求める */
function inlineChanges(a: Text, b: Text, blk: Omit<DiffBlock, 'inline'>): InlineChange[] {
  const fromA = a.line(blk.startLineA).from;
  const fromB = b.line(blk.startLineB).from;
  const textA = a.sliceString(fromA, a.line(blk.endLineA - 1).to);
  const textB = b.sliceString(fromB, b.line(blk.endLineB - 1).to);
  if (textA.length + textB.length > INLINE_MAX_CHARS) return [];
  return presentableDiff(textA, textB, INLINE_DIFF_CONFIG).map((c) => ({
    fromA: fromA + c.fromA,
    toA: fromA + c.toA,
    fromB: fromB + c.fromB,
    toB: fromB + c.toB,
  }));
}

/**
 * 2 つの文書を行単位で比較する。文書は変更しない。
 * 行どうしを比較して追加・削除・変更の範囲を求め、変更の範囲の内側だけ文字単位で比較する。
 */
export function computeDiff(a: Text, b: Text): DiffResult {
  const result: DiffResult = { blocks: [], added: 0, deleted: 0, changed: 0, precise: true };
  if (a.eq(b)) return result;

  // 空の文書は「行がない」ものとして、相手の全行を追加（削除）として扱う
  if (a.length === 0 || b.length === 0) {
    const empty = a.length === 0;
    tally(result, {
      kind: empty ? 'add' : 'del',
      startLineA: 1,
      endLineA: empty ? 1 : a.lines + 1,
      startLineB: 1,
      endLineB: empty ? b.lines + 1 : 1,
      inline: [],
    });
    return result;
  }

  const encoded = encodeLines([a, b]);
  if (encoded) {
    for (const c of diff(encoded[0], encoded[1], LINE_DIFF_CONFIG)) {
      // 行の列での位置（0 始まり）を行番号（1 始まり）にする
      const blk = {
        kind: blockKind(c.fromA, c.toA, c.fromB, c.toB),
        startLineA: c.fromA + 1,
        endLineA: c.toA + 1,
        startLineB: c.fromB + 1,
        endLineB: c.toB + 1,
      };
      tally(result, { ...blk, inline: blk.kind === 'chg' ? inlineChanges(a, b, blk) : [] });
    }
    return result;
  }

  // 異なる行が非常に多い場合は、文字単位の比較から行の範囲を求める（粗くなることがある）
  for (const chunk of Chunk.build(a, b, LINE_DIFF_CONFIG)) {
    const startLineA = startLine(a, chunk.fromA);
    const startLineB = startLine(b, chunk.fromB);
    const endLineA = chunk.toA === chunk.fromA ? startLineA : endLine(a, chunk.toA);
    const endLineB = chunk.toB === chunk.fromB ? startLineB : endLine(b, chunk.toB);
    const kind = blockKind(startLineA, endLineA, startLineB, endLineB);
    const inline =
      kind === 'chg'
        ? chunk.changes.map((c) => ({
            fromA: chunk.fromA + c.fromA,
            toA: chunk.fromA + c.toA,
            fromB: chunk.fromB + c.fromB,
            toB: chunk.fromB + c.toB,
          }))
        : [];
    tally(result, { kind, startLineA, endLineA, startLineB, endLineB, inline });
    if (!chunk.precise) result.precise = false;
  }
  return result;
}

/** 統一差分形式（Git の diff に近い形式）の 1 行の種類 */
export type UnifiedKind = 'hunk' | 'del' | 'add' | 'blank' | 'note';

export interface UnifiedLine {
  kind: UnifiedKind;
  /** 行頭に付ける記号（削除は「- 」、追加は「+ 」） */
  prefix: string;
  text: string;
  /** 比較元・比較先での行番号（該当しなければ null） */
  oldNo: number | null;
  newNo: number | null;
  /** 属する差分の番号（区切り行・案内行は -1） */
  block: number;
  /** 行内の異なる文字の範囲（text 内のオフセット） */
  marks: [number, number][];
}

export interface UnifiedDiff {
  /** 表示する本文 */
  text: string;
  lines: UnifiedLine[];
  /** 差分ごとの先頭・末尾の行（0 始まり。見出し行から最後の追加・削除行まで） */
  blocks: { first: number; last: number }[];
}

export const NO_DIFF_MESSAGE = '差分はありません';

/** git の hunk 見出しと同様に、空の範囲は直前の行番号で表す */
function hunkRange(start: number, end: number): string {
  const count = end - start;
  return `${count === 0 ? start - 1 : start},${count}`;
}

/** 範囲 [from, to) と行 line の重なりを、行内のオフセットで返す */
function clipToLine(line: { from: number; to: number }, changes: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [from, to] of changes) {
    const f = Math.max(from, line.from);
    const t = Math.min(to, line.to);
    if (t > f) out.push([f - line.from, t - line.from]);
  }
  return out;
}

/**
 * 差分のある箇所だけを、統一差分形式に近い形で整形する。変更のない行は含めない。
 * 変更行は、変更前（-）に続けて変更後（+）を並べる。
 */
export function formatUnified(result: DiffResult, a: Text, b: Text): UnifiedDiff {
  const lines: UnifiedLine[] = [];
  const blocks: { first: number; last: number }[] = [];
  if (result.blocks.length === 0) {
    lines.push({ kind: 'note', prefix: '', text: NO_DIFF_MESSAGE, oldNo: null, newNo: null, block: -1, marks: [] });
  }
  result.blocks.forEach((blk, index) => {
    if (index > 0) lines.push({ kind: 'blank', prefix: '', text: '', oldNo: null, newNo: null, block: -1, marks: [] });
    const first = lines.length;
    lines.push({
      kind: 'hunk',
      prefix: '',
      text: `@@ -${hunkRange(blk.startLineA, blk.endLineA)} +${hunkRange(blk.startLineB, blk.endLineB)} @@`,
      oldNo: null,
      newNo: null,
      block: index,
      marks: [],
    });
    const inlineA: [number, number][] = blk.inline.map((c) => [c.fromA, c.toA]);
    const inlineB: [number, number][] = blk.inline.map((c) => [c.fromB, c.toB]);
    for (let n = blk.startLineA; n < blk.endLineA; n++) {
      const line = a.line(n);
      lines.push({ kind: 'del', prefix: '- ', text: line.text, oldNo: n, newNo: null, block: index, marks: clipToLine(line, inlineA) });
    }
    for (let n = blk.startLineB; n < blk.endLineB; n++) {
      const line = b.line(n);
      lines.push({ kind: 'add', prefix: '+ ', text: line.text, oldNo: null, newNo: n, block: index, marks: clipToLine(line, inlineB) });
    }
    blocks.push({ first, last: lines.length - 1 });
  });
  return { text: lines.map((l) => l.prefix + l.text).join('\n'), lines, blocks };
}
