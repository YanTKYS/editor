import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { TabMeta } from '../../src/core/types';
import { batchExportArchive, batchExportFiles, sameExportMetadata } from '../../src/files/batchExport';

let id = 0;
const tab = (name: string, extra: Partial<TabMeta> = {}): TabMeta => ({
  id: String(++id), name, mode: 'plaintext', eol: 'LF', encoding: 'UTF-8', bom: false,
  modifiedSinceFile: true, createdAt: 0, updatedAt: 0, ...extra,
});
const readBlob = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

describe('一括ファイル書き出し', () => {
  it('未書き出しタブだけを候補とし、タブ番号と元の名前は維持する', () => {
    const original = [tab('saved.txt', { modifiedSinceFile: false }), tab('memo')];
    const files = batchExportFiles(original);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ tabNumber: 2, name: 'memo', fileName: 'memo.txt' });
    expect(original[1].name).toBe('memo');
    expect(original[1].modifiedSinceFile).toBe(true);
  });

  it('同名・大文字小文字・使用禁止文字・予約名の衝突を避ける', () => {
    const files = batchExportFiles(['a.txt', 'a.txt', 'A.TXT', 'a/b.txt', 'a_b.txt', 'CON.txt', 'CON.tar.gz', 'LPT1 .txt', 'name. '].map(n => tab(n)));
    expect(files.map(f => f.fileName)).toEqual(['a.txt', 'a (2).txt', 'A (3).TXT', 'a_b.txt', 'a_b (2).txt', '_CON.txt', '_CON.tar.gz', '_LPT1.txt', 'name.txt']);
    expect(batchExportFiles([tab('../../path')])[0].fileName).not.toMatch(/[\\/]/);
  });

  it('Unicodeの同一表記を区別し、長い日本語・絵文字の名前をバイト境界で整える', () => {
    const files = batchExportFiles([tab('é.txt'), tab('e\u0301.txt'), tab('日本語😀'.repeat(100) + '.txt')]);
    expect(files.map(f => f.fileName).slice(0, 2)).toEqual(['é.txt', 'é (2).txt']);
    expect(batchExportFiles([tab('σ.txt'), tab('ς.txt')]).map(f => f.fileName)).toEqual(['σ.txt', 'ς (2).txt']);
    const bytes = new TextEncoder().encode(files[2].fileName);
    expect(bytes.length).toBeLessThanOrEqual(255);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(files[2].fileName);
    expect(files[2].fileName).toMatch(/\.txt$/);
  });

  it('通常のZIPとして展開でき、UTF-8・改行コード・BOM・空ファイルを反映する', async () => {
    const files = batchExportFiles([tab('日本語.txt', { eol: 'CRLF', bom: true, encoding: 'Shift_JIS' }), tab('cr.txt', { eol: 'CR' }), tab('empty.txt')]);
    const snapshots = files.map((file, i) => ({ ...file, content: i === 2 ? '' : '日本語\n次の行' }));
    const blob = batchExportArchive(snapshots);
    expect(blob.type).toBe('application/zip');
    const bytes = await readBlob(blob);
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
    const extracted = unzipSync(bytes);
    expect(Object.keys(extracted)).toEqual(['日本語.txt', 'cr.txt', 'empty.txt']);
    expect([...extracted['日本語.txt'].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(extracted['日本語.txt'])).toBe('日本語\r\n次の行');
    expect(new TextDecoder().decode(extracted['cr.txt'])).toBe('日本語\r次の行');
    expect(extracted['empty.txt']).toHaveLength(0);
    expect(snapshots[0].content).toBe('日本語\n次の行');
  });

  it('対象なしや重複名の生成失敗で入力を変更しない', () => {
    expect(() => batchExportArchive([])).toThrow('書き出し対象');
    const [file] = batchExportFiles([tab('same.txt')]);
    const snapshot = { ...file, content: '本文' };
    expect(() => batchExportArchive([snapshot, { ...snapshot }])).toThrow('重複');
    expect(snapshot.content).toBe('本文');
  });

  it('保存後の名前・改行・BOM・モード・文字コードの変更と削除を検知する', () => {
    const original = tab('a.txt');
    const [file] = batchExportFiles([original]);
    expect(sameExportMetadata(file, original)).toBe(true);
    for (const extra of [{ name: 'b.txt' }, { eol: 'CRLF' }, { bom: true }, { mode: 'markdown' }, { encoding: 'Shift_JIS' }] as Partial<TabMeta>[]) {
      expect(sameExportMetadata(file, { ...original, ...extra })).toBe(false);
    }
    expect(sameExportMetadata(file, null)).toBe(false);
  });
});
