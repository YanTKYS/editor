import { describe, expect, it } from 'vitest';
import { applyLineEnding, detectLineEnding, normalizeLineEndings } from '../../src/core/lineEndings';

describe('改行コード', () => {
  it('支配的な改行コードを判定する', () => {
    expect(detectLineEnding('a\r\nb\r\nc').eol).toBe('CRLF');
    expect(detectLineEnding('a\nb\nc').eol).toBe('LF');
    expect(detectLineEnding('a\rb\rc').eol).toBe('CR');
    expect(detectLineEnding('改行なし').eol).toBe('LF');
    expect(detectLineEnding('改行なし', 'CRLF').eol).toBe('CRLF');
  });

  it('混在を検出する', () => {
    const info = detectLineEnding('a\r\nb\r\nc\nd');
    expect(info.eol).toBe('CRLF');
    expect(info.mixed).toBe(true);
    expect(info.counts).toEqual({ LF: 1, CRLF: 2, CR: 0 });
  });

  it('LF に正規化し、指定の改行コードに戻せる', () => {
    const src = '一行目\r\n二行目\r\n\r\n四行目';
    const normalized = normalizeLineEndings(src);
    expect(normalized).toBe('一行目\n二行目\n\n四行目');
    expect(applyLineEnding(normalized, 'CRLF')).toBe(src);
    expect(applyLineEnding(normalized, 'CR')).toBe('一行目\r二行目\r\r四行目');
    expect(applyLineEnding(normalized, 'LF')).toBe(normalized);
  });
});
