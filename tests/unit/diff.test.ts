import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { computeDiff, mapLine } from '../../src/core/diff';
import { buildDiffMarks } from '../../src/editor/diffMarks';

const doc = (s: string) => Text.of(s.split('\n'));

describe('computeDiff', () => {
  it('同一内容なら差分なし', () => {
    const r = computeDiff(doc('a\nb\nc'), doc('a\nb\nc'));
    expect(r).toMatchObject({ blocks: [], added: 0, deleted: 0, changed: 0, precise: true });
  });

  it('空文書どうしも差分なし', () => {
    expect(computeDiff(doc(''), doc('')).blocks).toEqual([]);
  });

  it('追加行を検出する', () => {
    const r = computeDiff(doc('a\nc'), doc('a\nb\nc'));
    expect(r.blocks).toEqual([
      { kind: 'add', startLineA: 2, endLineA: 2, startLineB: 2, endLineB: 3, inline: [] },
    ]);
    expect([r.added, r.deleted, r.changed]).toEqual([1, 0, 0]);
  });

  it('削除行を検出する', () => {
    const r = computeDiff(doc('a\nb\nc'), doc('a\nc'));
    expect(r.blocks).toEqual([
      { kind: 'del', startLineA: 2, endLineA: 3, startLineB: 2, endLineB: 2, inline: [] },
    ]);
    expect([r.added, r.deleted, r.changed]).toEqual([0, 1, 0]);
  });

  it('変更行を検出し、行内の異なる文字の位置を返す', () => {
    const r = computeDiff(doc('hello world\nsame'), doc('hello brave world\nsame'));
    expect(r.blocks).toHaveLength(1);
    const [b] = r.blocks;
    expect([b.kind, b.startLineA, b.endLineA, b.startLineB, b.endLineB]).toEqual(['chg', 1, 2, 1, 2]);
    expect(b.inline).toEqual([{ fromA: 6, toA: 6, fromB: 6, toB: 12 }]);
    expect([r.added, r.deleted, r.changed]).toEqual([0, 0, 1]);
  });

  it('複数の差分をそれぞれ数える', () => {
    const a = doc('1\n2\n3\n4\n5\n6\n7');
    const b = doc('1\nX\n3\n5\n6\n6.5\n7\n8');
    const r = computeDiff(a, b);
    expect(r.blocks.map((x) => x.kind)).toEqual(['chg', 'del', 'add', 'add']);
    expect(r.added + r.deleted + r.changed).toBe(r.blocks.length);
  });

  it('日本語の行内の違いを検出する', () => {
    const r = computeDiff(doc('こんにちは世界\nabc'), doc('こんばんは世界\nabc'));
    expect(r.blocks).toHaveLength(1);
    const inline = r.blocks[0].inline;
    expect(inline.length).toBeGreaterThan(0);
    const changedA = inline.map((c) => '' + doc('こんにちは世界\nabc').sliceString(c.fromA, c.toA)).join('');
    expect(changedA).toContain('に');
  });

  it('末尾に改行があるだけの違いは、空の最終行の追加として扱う', () => {
    const r = computeDiff(doc('a\nb'), doc('a\nb\n'));
    expect(r.blocks).toEqual([{ kind: 'add', startLineA: 3, endLineA: 3, startLineB: 3, endLineB: 4, inline: [] }]);
  });

  it('近接した複数の差分でも、変更のない行は差分にしない', () => {
    const r = computeDiff(doc('1\n2\n3\n4\n5\n6\n7'), doc('1\nX\n3\n5\n6\n6.5\n7\n8'));
    expect(r.blocks.map((x) => [x.kind, x.startLineA, x.endLineA, x.startLineB, x.endLineB])).toEqual([
      ['chg', 2, 3, 2, 3],
      ['del', 4, 5, 4, 4],
      ['add', 7, 7, 6, 7],
      ['add', 8, 8, 8, 9],
    ]);
  });

  it('異なる行が非常に多い文書でも差分を返す', () => {
    const n = 70000;
    const a = doc(Array.from({ length: n }, (_, i) => `a${i}`).join('\n'));
    const b = doc(Array.from({ length: n }, (_, i) => (i === 3 ? 'changed' : `a${i}`)).join('\n'));
    const r = computeDiff(a, b);
    expect(r.blocks.length).toBeGreaterThan(0);
    expect(r.blocks[0].startLineA).toBeLessThanOrEqual(4);
  });

  it('空文書との比較は全行の追加・削除になる', () => {
    expect(computeDiff(doc(''), doc('x\ny')).blocks[0]).toMatchObject({ startLineB: 1, endLineB: 3 });
    expect(computeDiff(doc('x\ny'), doc('')).blocks[0]).toMatchObject({ startLineA: 1, endLineA: 3 });
  });
});

describe('mapLine', () => {
  const r = computeDiff(doc('a\nb\nc\nd\ne'), doc('a\nX\nY\nZ\nc\nd\ne'));
  // A の 2 行目（b）が B の 2〜4 行目（X,Y,Z）に置き換わった
  it('差分のない範囲は行数のずれを補正する', () => {
    expect(mapLine(r.blocks, 'a', 1)).toBe(1);
    expect(mapLine(r.blocks, 'a', 3)).toBe(5);
    expect(mapLine(r.blocks, 'a', 5.5)).toBe(7.5);
    expect(mapLine(r.blocks, 'b', 5)).toBe(3);
  });

  it('差分の内側は範囲の長さに比例して対応づける', () => {
    expect(mapLine(r.blocks, 'a', 2)).toBe(2);
    expect(mapLine(r.blocks, 'a', 2.5)).toBe(3.5);
    expect(mapLine(r.blocks, 'b', 3)).toBeCloseTo(2 + 1 / 3);
  });

  it('差分がなければそのまま', () => {
    expect(mapLine([], 'a', 7.25)).toBe(7.25);
  });

  it('追加のみの位置では、相手側の追加範囲の先頭に対応づける', () => {
    const add = computeDiff(doc('a\nc'), doc('a\nb\nb2\nc'));
    expect(mapLine(add.blocks, 'a', 1.5)).toBe(1.5);
    expect(mapLine(add.blocks, 'a', 2)).toBe(2);
    expect(mapLine(add.blocks, 'a', 2.5)).toBe(4.5);
  });
});

describe('buildDiffMarks', () => {
  const classesOf = (marks: ReturnType<typeof buildDiffMarks>) => {
    const out: { from: number; to: number; cls: string }[] = [];
    const iter = marks.iter();
    while (iter.value) {
      out.push({ from: iter.from, to: iter.to, cls: (iter.value.spec as { class: string }).class });
      iter.next();
    }
    return out;
  };

  it('削除は A 側、追加は B 側の行を強調する', () => {
    const a = doc('a\nb\nc\nz');
    const b = doc('a\nc\nz\nd');
    const r = computeDiff(a, b);
    const ma = classesOf(buildDiffMarks(r, 'a', a, -1));
    const mb = classesOf(buildDiffMarks(r, 'b', b, -1));
    expect(ma.some((m) => m.cls.startsWith('cm-diff-del'))).toBe(true);
    expect(ma.some((m) => m.cls.startsWith('cm-diff-add'))).toBe(false);
    expect(mb.some((m) => m.cls.startsWith('cm-diff-add'))).toBe(true);
  });

  it('変更行は両側に出し、行内の異なる文字を強調する', () => {
    const a = doc('hello world');
    const b = doc('hello brave world');
    const r = computeDiff(a, b);
    const ma = classesOf(buildDiffMarks(r, 'a', a, -1));
    const mb = classesOf(buildDiffMarks(r, 'b', b, -1));
    expect(ma.map((m) => m.cls)).toEqual(['cm-diff-chg']);
    expect(mb.map((m) => m.cls)).toEqual(['cm-diff-chg', 'cm-diff-text-add']);
    expect(mb[1]).toMatchObject({ from: 6, to: 12 });
  });

  it('相手側にだけある行の位置に境界線を付ける（文書末尾は後ろ側）', () => {
    const a = doc('a\nb');
    const b = doc('a\nb\nc\nd\n');
    const r = computeDiff(a, b);
    const gap = classesOf(buildDiffMarks(r, 'a', a, 0)).find((m) => m.cls.includes('gap'));
    expect(gap?.cls).toBe('cm-diff-gap-after cm-diff-current');
    const gapOnly = computeDiff(doc('a\nc'), doc('a\nb\nc'));
    const marks = classesOf(buildDiffMarks(gapOnly, 'a', doc('a\nc'), -1));
    expect(marks).toEqual([{ from: 2, to: 2, cls: 'cm-diff-gap-before' }]);
  });

  it('選択中の差分だけ cm-diff-current を付ける', () => {
    const a = doc('1\n2\n3\n4\n5');
    const b = doc('1\nX\n3\nY\n5');
    const r = computeDiff(a, b);
    const marks = classesOf(buildDiffMarks(r, 'b', b, 1)).filter((m) => m.cls.startsWith('cm-diff-chg'));
    expect(marks.map((m) => m.cls.includes('cm-diff-current'))).toEqual([false, true]);
  });
});
