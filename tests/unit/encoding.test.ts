import { describe, expect, it } from 'vitest';
import { decodeBytes, encodeUtf8, InvalidEncodingError, looksBinary } from '../../src/core/encoding';

/** 「日本語」の Shift_JIS バイト列 */
const SJIS_NIHONGO = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

describe('文字コード', () => {
  it('UTF-8 を復号し、BOM を検出する', () => {
    const bytes = encodeUtf8('こんにちは', true);
    const r = decodeBytes(bytes, 'UTF-8');
    expect(r.text).toBe('こんにちは');
    expect(r.bom).toBe(true);
    expect(decodeBytes(encodeUtf8('abc', false), 'UTF-8').bom).toBe(false);
  });

  it('UTF-8 として不正なバイト列は strict でエラーになる', () => {
    expect(() => decodeBytes(SJIS_NIHONGO, 'UTF-8')).toThrow(InvalidEncodingError);
    expect(decodeBytes(SJIS_NIHONGO, 'UTF-8', false).text).toContain('�');
  });

  it('Shift_JIS を復号できる', () => {
    const r = decodeBytes(SJIS_NIHONGO, 'Shift_JIS');
    expect(r.text).toBe('日本語');
    expect(r.encoding).toBe('Shift_JIS');
  });

  it('NUL を含むデータをバイナリと判定する', () => {
    expect(looksBinary(new Uint8Array([0x41, 0x00, 0x42]))).toBe(true);
    expect(looksBinary(encodeUtf8('テキスト', false))).toBe(false);
  });
});
