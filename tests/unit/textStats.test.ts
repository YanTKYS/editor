import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { columnAt, countChars, offsetForColumn } from '../../src/app/textStats';

describe('文字数', () => {
  it('改行を除き、サロゲートペアを 1 文字として数える', () => {
    const doc = Text.of(['あいう', '𠮷野家', '']);
    expect(countChars(doc)).toBe(6);
    expect(countChars(doc, 0, 2)).toBe(2);
  });

  it('列番号を文字単位で扱う', () => {
    expect(columnAt('𠮷野家', 2)).toBe(2);
    expect(columnAt('𠮷野家', 4)).toBe(4);
    expect(offsetForColumn('𠮷野家', 2)).toBe(2);
    expect(offsetForColumn('𠮷野家', 99)).toBe(4);
    expect(offsetForColumn('abc', 1)).toBe(0);
  });
});
