import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import {
  StorageConflictError,
  StorageQuotaError,
  type StorageBackend,
  type WriteBatch,
  type WriteOptions,
} from '../../src/storage/backend';
import { LocalStorageBackend } from '../../src/storage/localStorageBackend';
import { PersistenceController, type SaveStatus } from '../../src/storage/persistence';
import { MemoryStorage } from './memoryStorage';

class FakeBackend implements StorageBackend {
  readonly name = 'fake';
  writes: { batch: WriteBatch; options: WriteOptions }[] = [];
  fail: Error | null = null;
  revision = 0;
  async load() {
    return { status: 'empty' as const };
  }
  async write(batch: WriteBatch, options: WriteOptions) {
    this.writes.push({ batch, options });
    if (this.fail) throw this.fail;
    if (!options.force && options.expectedRevision !== this.revision) {
      throw new StorageConflictError(this.revision, 'x');
    }
    this.revision = Math.max(this.revision, options.expectedRevision) + 1;
    return { revision: this.revision };
  }
  subscribe() {
    return () => {};
  }
  async usage() {
    return { appChars: 0, totalChars: 0, quotaChars: null };
  }
  async dumpRaw() {
    return {};
  }
  async clear() {}
}

let contents: Record<string, string> = { a: 'A', b: 'B' };
const provider = {
  buildMeta: () => ({
    schemaVersion: 1,
    app: 'x',
    activeTabId: 'a',
    settings: DEFAULT_SETTINGS,
    layout: { count: 1, tabs: ['a'], active: 0 },
    tabs: Object.keys(contents).map((id) => ({
      id,
      name: id,
      mode: 'plaintext' as const,
      eol: 'LF' as const,
      encoding: 'UTF-8' as const,
      bom: false,
      modifiedSinceFile: false,
      createdAt: 0,
      updatedAt: 0,
    })),
  }),
  getContent: (id: string) => contents[id] ?? '',
};

describe('PersistenceController', () => {
  let backend: FakeBackend;
  let ctrl: PersistenceController;
  let statuses: SaveStatus['kind'][];

  beforeEach(() => {
    vi.useFakeTimers();
    contents = { a: 'A', b: 'B' };
    backend = new FakeBackend();
    ctrl = new PersistenceController(backend, provider, 'me', { delay: 500, maxWait: 2000, retryDelay: 1000 });
    statuses = [];
    ctrl.events.on('status', (s) => statuses.push(s.kind));
    ctrl.start(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('入力が続く間は保存を遅らせ、まとめて書き込む', async () => {
    ctrl.markTabDirty('a');
    await vi.advanceTimersByTimeAsync(300);
    ctrl.markTabDirty('a');
    await vi.advanceTimersByTimeAsync(300);
    expect(backend.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(backend.writes).toHaveLength(1);
    expect([...backend.writes[0].batch.contents.keys()]).toEqual(['a']);
    expect(ctrl.status.kind).toBe('saved');
    expect(statuses).toContain('pending');
  });

  it('入力が続いても maxWait で保存する', async () => {
    for (let i = 0; i < 10; i++) {
      ctrl.markTabDirty('a');
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(backend.writes.length).toBeGreaterThanOrEqual(1);
  });

  it('変更のないタブの本文は書き込まない', async () => {
    ctrl.markMetaDirty();
    await ctrl.flush();
    expect(backend.writes[0].batch.contents.size).toBe(0);
  });

  it('容量超過時は変更を保持したまま失敗状態になり、再試行で保存する', async () => {
    backend.fail = new StorageQuotaError();
    ctrl.markTabDirty('b');
    await ctrl.flush();
    expect(ctrl.status).toMatchObject({ kind: 'error', reason: 'quota' });
    expect(ctrl.hasUnsavedChanges).toBe(true);
    backend.fail = null;
    expect(await ctrl.flush()).toBe(true);
    expect(ctrl.status.kind).toBe('saved');
    expect([...backend.writes[1].batch.contents.keys()]).toEqual(['b']);
  });

  it('競合を検知したら自動保存を止め、上書き指示で強制保存する', async () => {
    backend.revision = 5; // 他のタブが書き込んだ
    ctrl.markTabDirty('a');
    await ctrl.flush();
    expect(ctrl.status.kind).toBe('conflict');
    ctrl.markTabDirty('a');
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.writes).toHaveLength(1); // 自動保存されない
    expect(await ctrl.overwrite(['a', 'b'])).toBe(true);
    const last = backend.writes.at(-1)!;
    expect(last.options.force).toBe(true);
    expect(last.batch.pruneOrphans).toBe(true);
    expect([...last.batch.contents.keys()].sort()).toEqual(['a', 'b']);
    expect(ctrl.status.kind).toBe('saved');
  });

  it('閉じたタブは削除対象として書き込む', async () => {
    ctrl.markTabDirty('c');
    ctrl.markTabRemoved('c');
    await ctrl.flush();
    expect(backend.writes[0].batch.removed).toEqual(['c']);
    expect(backend.writes[0].batch.contents.has('c')).toBe(false);
  });

  it('block 中・suspend 後は書き込まない', async () => {
    ctrl.block('壊れています');
    ctrl.markTabDirty('a');
    expect(await ctrl.flush()).toBe(false);
    ctrl.start(0);
    ctrl.suspend();
    ctrl.markTabDirty('a');
    expect(await ctrl.flush()).toBe(false);
    expect(backend.writes).toHaveLength(0);
  });

  it('backend がなければ利用不可状態になる', () => {
    const c = new PersistenceController(null, provider, 'me');
    expect(c.status.kind).toBe('unavailable');
  });

  it('非同期の書き込みが完了するまでは未保存として扱う', async () => {
    ctrl.markTabDirty('a');
    const p = ctrl.flush();
    expect(ctrl.hasUnsavedChanges).toBe(true);
    expect(await p).toBe(true);
    expect(ctrl.hasUnsavedChanges).toBe(false);
  });
});

describe('PersistenceController + LocalStorageBackend（同期書き込み）', () => {
  let storage: MemoryStorage;
  let backend: LocalStorageBackend;
  let ctrl: PersistenceController;

  beforeEach(() => {
    contents = { a: '保存済みA', b: '保存済みB' };
    storage = new MemoryStorage();
    backend = new LocalStorageBackend(storage, 'test');
    ctrl = new PersistenceController(backend, provider, 'me');
    ctrl.start(0);
    ctrl.markAllDirty(['a', 'b']);
  });

  it('保存結果は flush() から戻った時点で確定している（ページ終了直前の判定用）', async () => {
    void ctrl.flush();
    expect(ctrl.hasUnsavedChanges).toBe(false);
    expect(ctrl.status.kind).toBe('saved');

    storage.failOn = () => new DOMException('quota', 'QuotaExceededError');
    contents.a = '未保存の編集';
    ctrl.markTabDirty('a');
    void ctrl.flush(); // await しない（beforeunload と同じ条件）
    expect(ctrl.hasUnsavedChanges).toBe(true);
    expect(ctrl.status).toMatchObject({ kind: 'error', reason: 'quota' });
  });

  it('タブを閉じて編集した後の保存が失敗しても、直前の保存データを保ち、再試行で反映する', async () => {
    expect(await ctrl.flush()).toBe(true);
    const before = storage.snapshot();

    // タブ A を閉じ、B を編集 → B の書き込みで失敗
    delete contents.a;
    contents.b = '編集後B';
    ctrl.markTabRemoved('a');
    ctrl.markTabDirty('b');
    storage.failOn = (key) => (key === 'test:tab:b' ? new DOMException('quota', 'QuotaExceededError') : null);
    expect(await ctrl.flush()).toBe(false);
    expect(storage.snapshot()).toEqual(before);
    const loaded = await backend.load();
    expect(loaded.status === 'ok' && [...loaded.contents]).toEqual([
      ['a', '保存済みA'],
      ['b', '保存済みB'],
    ]);

    // 容量が空いたら、閉じたタブの削除と編集内容がまとめて反映される
    storage.failOn = null;
    expect(await ctrl.flush()).toBe(true);
    const after = await backend.load();
    expect(after.status === 'ok' && [...after.contents]).toEqual([['b', '編集後B']]);
    expect(storage.getItem('test:tab:a')).toBeNull();
  });
});
