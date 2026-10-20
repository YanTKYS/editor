import { beforeEach, describe, expect, it } from 'vitest';
import { StorageConflictError, StorageQuotaError, type WriteBatch } from '../../src/storage/backend';
import { LocalStorageBackend } from '../../src/storage/localStorageBackend';
import { APP_ID, SCHEMA_VERSION } from '../../src/storage/schema';
import { DEFAULT_SETTINGS, type PersistedTabMeta } from '../../src/core/types';
import { MemoryStorage } from './memoryStorage';

function tabMeta(id: string, name = id): PersistedTabMeta {
  return {
    id,
    name,
    mode: 'plaintext',
    eol: 'LF',
    encoding: 'UTF-8',
    bom: false,
    modifiedSinceFile: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function batch(tabs: Record<string, string>, removed: string[] = [], active: string | null = null): WriteBatch {
  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      app: APP_ID,
      activeTabId: active ?? Object.keys(tabs)[0] ?? null,
      settings: DEFAULT_SETTINGS,
      tabs: Object.keys(tabs).map((id) => tabMeta(id)),
    },
    contents: new Map(Object.entries(tabs)),
    removed,
  };
}

describe('LocalStorageBackend', () => {
  let storage: MemoryStorage;
  let backend: LocalStorageBackend;

  beforeEach(() => {
    storage = new MemoryStorage();
    backend = new LocalStorageBackend(storage, 'test');
  });

  it('空の状態を返す', async () => {
    expect(await backend.load()).toEqual({ status: 'empty' });
  });

  it('保存した内容を復元する', async () => {
    const { revision } = await backend.write(batch({ a: '本文A', b: '本文B' }, [], 'b'), {
      writerId: 'w1',
      expectedRevision: 0,
    });
    expect(revision).toBe(1);
    const loaded = await backend.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.meta.tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(loaded.meta.activeTabId).toBe('b');
    expect(loaded.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loaded.contents.get('a')).toBe('本文A');
    expect(loaded.missing).toEqual([]);
  });

  it('変更のあったタブ本文だけを書き込む', async () => {
    await backend.write(batch({ a: '1', b: '2' }), { writerId: 'w', expectedRevision: 0 });
    const b2 = batch({ a: 'x', b: 'ignored' });
    b2.contents = new Map([['a', 'updated']]);
    await backend.write(b2, { writerId: 'w', expectedRevision: 1 });
    expect(storage.getItem('test:tab:a')).toBe('updated');
    expect(storage.getItem('test:tab:b')).toBe('2');
  });

  it('削除したタブの本文を消す', async () => {
    await backend.write(batch({ a: '1', b: '2' }), { writerId: 'w', expectedRevision: 0 });
    const b2 = batch({ a: '1' }, ['b']);
    b2.contents = new Map();
    await backend.write(b2, { writerId: 'w', expectedRevision: 1 });
    expect(storage.getItem('test:tab:b')).toBeNull();
  });

  it('他のインスタンスが書き込んでいたら競合として拒否する', async () => {
    const other = new LocalStorageBackend(storage, 'test');
    await backend.write(batch({ a: '自分' }), { writerId: 'me', expectedRevision: 0 });
    await other.write(batch({ a: '他人' }), { writerId: 'other', expectedRevision: 1 });
    await expect(backend.write(batch({ a: '上書き' }), { writerId: 'me', expectedRevision: 1 })).rejects.toBeInstanceOf(
      StorageConflictError,
    );
    expect(storage.getItem('test:tab:a')).toBe('他人');
    // 強制上書き
    const r = await backend.write({ ...batch({ a: '上書き' }), pruneOrphans: true }, {
      writerId: 'me',
      expectedRevision: 1,
      force: true,
    });
    expect(r.revision).toBe(3);
    expect(storage.getItem('test:tab:a')).toBe('上書き');
  });

  it('容量超過を StorageQuotaError として通知し、保存済みデータを壊さない', async () => {
    storage.quotaChars = 600;
    await backend.write(batch({ a: 'small' }), { writerId: 'w', expectedRevision: 0 });
    const before = storage.getItem('test:meta');
    await expect(
      backend.write(batch({ a: 'small', big: 'x'.repeat(1000) }), { writerId: 'w', expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(StorageQuotaError);
    expect(storage.getItem('test:meta')).toBe(before);
    const loaded = await backend.load();
    expect(loaded.status === 'ok' && loaded.contents.get('a')).toBe('small');
  });

  it('タブ削除と本文書き込みの途中で容量超過になったら、直前の保存状態に戻す', async () => {
    await backend.write(batch({ a: '本文A', b: '本文B' }), { writerId: 'w', expectedRevision: 0 });
    const before = storage.snapshot();
    // A を閉じ、B を大きく編集し、新しいタブ C を追加 → B の書き込みで容量超過
    storage.quotaChars = JSON.stringify(before).length + 50;
    const b2 = batch({ b: 'B'.repeat(500), c: '新規C' }, ['a']);
    await expect(backend.write(b2, { writerId: 'w', expectedRevision: 1 })).rejects.toBeInstanceOf(StorageQuotaError);
    expect(storage.snapshot()).toEqual(before);
    const loaded = await backend.load();
    expect(loaded.status === 'ok' && [...loaded.contents]).toEqual([
      ['a', '本文A'],
      ['b', '本文B'],
    ]);
  });

  it('書き込み途中の容量超過以外の例外でも、直前の保存状態に戻して元の例外を送出する', async () => {
    await backend.write(batch({ a: '本文A', b: '本文B' }), { writerId: 'w', expectedRevision: 0 });
    const before = storage.snapshot();
    const failure = new Error('書き込みエラー');
    storage.failOn = (key) => (key === 'test:tab:c' ? failure : null);
    const b2 = batch({ a: '変更A', c: '新規C' }, ['b']);
    await expect(backend.write(b2, { writerId: 'w', expectedRevision: 1 })).rejects.toBe(failure);
    storage.failOn = null;
    expect(storage.snapshot()).toEqual(before);
  });

  it('メタ情報の書き込みに失敗したら、書き込み済みの本文も元に戻す', async () => {
    await backend.write(batch({ a: '本文A' }), { writerId: 'w', expectedRevision: 0 });
    const before = storage.snapshot();
    storage.failOn = (key) => (key === 'test:meta' ? new DOMException('quota', 'QuotaExceededError') : null);
    await expect(
      backend.write(batch({ a: '変更A', n: '新規' }), { writerId: 'w', expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(StorageQuotaError);
    storage.failOn = null;
    expect(storage.snapshot()).toEqual(before);
    expect(storage.getItem('test:tab:n')).toBeNull();
  });

  it('壊れたデータ・新しいスキーマを検出する', async () => {
    storage.setItem('test:meta', '{broken');
    expect(await backend.load()).toMatchObject({ status: 'error', kind: 'corrupt' });
    storage.setItem('test:meta', JSON.stringify({ app: APP_ID, schemaVersion: SCHEMA_VERSION + 1, tabs: [] }));
    expect(await backend.load()).toMatchObject({ status: 'error', kind: 'newer' });
  });

  it('本文の欠落を報告する', async () => {
    await backend.write(batch({ a: '1', b: '2' }), { writerId: 'w', expectedRevision: 0 });
    storage.removeItem('test:tab:b');
    const loaded = await backend.load();
    expect(loaded.status === 'ok' && loaded.missing).toEqual(['b']);
  });

  it('不正なタブ情報や設定値を補正して読み込む', async () => {
    storage.setItem(
      'test:meta',
      JSON.stringify({
        app: APP_ID,
        schemaVersion: 1,
        revision: 4,
        tabs: [{ id: 'a', name: '', mode: 'nope', eol: 'X', selection: { ranges: [{ anchor: 'x' }], main: 0 } }, { id: 'a' }, 42],
        settings: { tabSize: 0, wordWrap: 'yes' },
      }),
    );
    const loaded = await backend.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.meta.tabs).toHaveLength(1);
    expect(loaded.meta.tabs[0]).toMatchObject({ name: '無題', mode: 'plaintext', eol: 'LF', selection: undefined });
    expect(loaded.meta.settings.tabSize).toBe(1);
    expect(loaded.meta.settings.wordWrap).toBe(DEFAULT_SETTINGS.wordWrap);
    expect(loaded.meta.revision).toBe(4);
  });

  it('使用量を計算し、自分のデータだけを消去する', async () => {
    storage.setItem('other-app', 'keep');
    await backend.write(batch({ a: '12345' }), { writerId: 'w', expectedRevision: 0 });
    const u = await backend.usage();
    expect(u.appChars).toBeGreaterThan(5);
    expect(u.totalChars).toBeGreaterThan(u.appChars);
    await backend.clear();
    expect(storage.getItem('other-app')).toBe('keep');
    expect(await backend.load()).toEqual({ status: 'empty' });
  });
});
