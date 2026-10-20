import { describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, BackupValidationError, createBackup, parseBackup } from '../../src/core/backup';
import { DEFAULT_SETTINGS } from '../../src/core/types';

const tab = { name: 'a.md', content: '# A\r\nB', mode: 'markdown' as const, eol: 'CRLF' as const, encoding: 'UTF-8' as const, bom: false };

describe('バックアップ', () => {
  it('書き出した内容をそのまま復元できる', () => {
    const backup = createBackup([tab, { ...tab, name: 'b.txt', mode: 'plaintext' }], 1, DEFAULT_SETTINGS, '0.1.0');
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.tabs).toHaveLength(2);
    expect(parsed.tabs[0].content).toBe('# A\nB'); // 内部表現は LF
    expect(parsed.tabs[0].eol).toBe('CRLF');
    expect(parsed.activeIndex).toBe(1);
    expect(parsed.settings).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    ['not json', 'JSON'],
    ['[]', '形式'],
    [JSON.stringify({ format: 'other' }), 'バックアップファイルではありません'],
    [JSON.stringify({ format: BACKUP_FORMAT, version: 99, tabs: [tab] }), '新しいバージョン'],
    [JSON.stringify({ format: BACKUP_FORMAT, version: 1, tabs: [] }), '1 つも'],
    [JSON.stringify({ format: BACKUP_FORMAT, version: 1, tabs: [{ name: 'x' }] }), '本文'],
    [JSON.stringify({ format: BACKUP_FORMAT, version: 1, tabs: [{ name: '', content: '' }] }), '名前'],
  ])('不正なデータを拒否する: %s', (json, message) => {
    expect(() => parseBackup(json)).toThrow(BackupValidationError);
    expect(() => parseBackup(json)).toThrow(message);
  });

  it('不明な値は既定値で補完する', () => {
    const parsed = parseBackup(
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        activeIndex: 5,
        settings: { fontSize: 999, theme: 'neon' },
        tabs: [{ name: 'x', content: 'y', mode: 'cobol', eol: '??' }],
      }),
    );
    expect(parsed.tabs[0]).toMatchObject({ mode: 'plaintext', eol: 'LF', encoding: 'UTF-8' });
    expect(parsed.activeIndex).toBe(0);
    expect(parsed.settings.fontSize).toBe(40);
    expect(parsed.settings.theme).toBe(DEFAULT_SETTINGS.theme);
  });
});

describe('バックアップの画面分割', () => {
  it('画面分割の状態を書き出し・復元できる', () => {
    const backup = createBackup([tab, tab, tab], 0, DEFAULT_SETTINGS, '0.2.0', { count: 3, panes: [2, null, 0], active: 1 });
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.layout).toEqual({ count: 3, panes: [2, null, 0], active: 1 });
    // 形式のバージョンは v0.1.0 と同じ（v0.1.0 でも読み込める）
    expect(parsed.version).toBe(1);
  });

  it('v0.1.0 のバックアップ（画面分割なし）も読み込める', () => {
    const v010 = { format: BACKUP_FORMAT, version: 1, appVersion: '0.1.0', exportedAt: '', activeIndex: 0, settings: DEFAULT_SETTINGS, tabs: [tab] };
    expect(parseBackup(JSON.stringify(v010)).layout).toBeUndefined();
  });

  it('不正な画面分割の情報は補正または無視する', () => {
    const base = { format: BACKUP_FORMAT, version: 1, tabs: [tab, tab] };
    expect(parseBackup(JSON.stringify({ ...base, layout: { count: 9, panes: [] } })).layout).toBeUndefined();
    expect(parseBackup(JSON.stringify({ ...base, layout: { count: 2, panes: [1, 1], active: 5 } })).layout).toEqual({
      count: 2,
      panes: [1, null],
      active: 0,
    });
    expect(parseBackup(JSON.stringify({ ...base, layout: { count: 2, panes: [7, -1] } })).layout).toEqual({
      count: 2,
      panes: [null, null],
      active: 0,
    });
  });
});
