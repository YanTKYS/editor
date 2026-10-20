import { describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../../src/core/encoding';
import { bytesToLoadedFile, encodeForExport, exportFileName, sanitizeFileName } from '../../src/files/fileIO';

describe('ファイル入出力', () => {
  it('読み込んだ改行コードと BOM を記録し、書き出し時に復元する', () => {
    const original = 'A\r\nB\r\n日本語\r\n';
    const bytes = encodeUtf8(original, true);
    const r = bytesToLoadedFile('a.txt', bytes, 'UTF-8');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.content).toBe('A\nB\n日本語\n');
    expect(r.file.eol).toBe('CRLF');
    expect(r.file.bom).toBe(true);
    expect(encodeForExport(r.file.content, r.file.eol, r.file.bom)).toEqual(bytes);
  });

  it('Shift_JIS のファイルを読み込める', () => {
    const r = bytesToLoadedFile('sjis.txt', new Uint8Array([0x82, 0xa0, 0x0d, 0x0a, 0x82, 0xa2]), 'Shift_JIS');
    expect(r.ok && r.file.content).toBe('あ\nい');
    expect(r.ok && r.file.eol).toBe('CRLF');
  });

  it('UTF-8 として不正なファイルは encoding エラーを返す', () => {
    const r = bytesToLoadedFile('sjis.txt', new Uint8Array([0x82, 0xa0]), 'UTF-8');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('encoding');
  });

  it('バイナリファイルを拒否する', () => {
    const r = bytesToLoadedFile('a.bin', new Uint8Array([1, 0, 2]), 'UTF-8');
    expect(!r.ok && r.reason).toBe('binary');
  });

  it('書き出しファイル名を整える', () => {
    expect(exportFileName('新規 1', 'plaintext')).toBe('新規 1.txt');
    expect(exportFileName('memo', 'markdown')).toBe('memo.md');
    expect(exportFileName('data.json', 'json')).toBe('data.json');
    expect(sanitizeFileName('a/b:c*?.txt')).toBe('a_b_c__.txt');
    expect(sanitizeFileName('   ')).toBe('untitled');
  });
});
