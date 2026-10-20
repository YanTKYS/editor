import type { Text } from '@codemirror/state';

const SURROGATE_HIGH = /[\uD800-\uDBFF]/g;

export function countInString(s: string): number {
  const surrogates = s.match(SURROGATE_HIGH)?.length ?? 0;
  return s.length - surrogates;
}

const cache = new WeakMap<Text, number>();

/**
 * 文字数を数える（改行を除き、サロゲートペアは 1 文字として数える）。
 * 文書全体の文字数は Text オブジェクトごとにキャッシュする。
 */
export function countChars(doc: Text, from = 0, to = doc.length): number {
  const whole = from === 0 && to === doc.length;
  if (whole) {
    const cached = cache.get(doc);
    if (cached !== undefined) return cached;
  }
  let n = 0;
  const iter = doc.iterRange(from, to);
  for (let r = iter.next(); !r.done; r = iter.next()) {
    if (iter.lineBreak) continue;
    n += countInString(iter.value);
  }
  if (whole) cache.set(doc, n);
  return n;
}

/** 行頭からのオフセット（UTF-16 単位）を 1 始まりの列番号（文字単位）に変換する */
export function columnAt(lineText: string, offset: number): number {
  return countInString(lineText.slice(0, offset)) + 1;
}

/** 1 始まりの列番号（文字単位）を行頭からのオフセット（UTF-16 単位）に変換する */
export function offsetForColumn(lineText: string, column: number): number {
  let offset = 0;
  for (let c = 1; c < column && offset < lineText.length; c++) {
    const code = lineText.charCodeAt(offset);
    offset += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
  }
  return Math.min(offset, lineText.length);
}
