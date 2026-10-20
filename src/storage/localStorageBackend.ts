import {
  StorageConflictError,
  StorageQuotaError,
  StorageUnavailableError,
  type ExternalChange,
  type LoadResult,
  type StorageBackend,
  type StorageUsage,
  type WriteBatch,
  type WriteOptions,
} from './backend';
import { APP_ID, parseMeta, peekRevision, SCHEMA_VERSION, SchemaError, type PersistedMeta } from './schema';

export const DEFAULT_PREFIX = 'webTextEditor';

/** 一般的なブラウザの localStorage 上限（約 500 万文字）。実際の値はブラウザにより異なる */
const ESTIMATED_QUOTA_CHARS = 5 * 1024 * 1024;

function isQuotaError(e: unknown): boolean {
  if (!(e instanceof DOMException)) return false;
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014
  );
}

/**
 * localStorage を使った保存処理。
 * - `<prefix>:meta` にタブ構成・設定（JSON）
 * - `<prefix>:tab:<id>` に各タブの本文（文字列そのまま）
 * を保存し、変更のあったタブの本文だけを書き込む。
 */
export class LocalStorageBackend implements StorageBackend {
  readonly name = 'localStorage';
  private readonly metaKey: string;
  private readonly tabPrefix: string;

  constructor(
    private readonly storage: Storage,
    private readonly prefix = DEFAULT_PREFIX,
  ) {
    this.metaKey = `${prefix}:meta`;
    this.tabPrefix = `${prefix}:tab:`;
  }

  /** localStorage が利用可能かを確認して backend を作成する */
  static create(prefix = DEFAULT_PREFIX): LocalStorageBackend {
    let storage: Storage;
    try {
      storage = window.localStorage;
      const probe = `${prefix}:probe`;
      storage.setItem(probe, '1');
      storage.removeItem(probe);
    } catch (e) {
      // 容量超過時は probe の書き込みにも失敗するが、読み込み自体は可能
      if (isQuotaError(e)) return new LocalStorageBackend(window.localStorage, prefix);
      throw new StorageUnavailableError(e);
    }
    return new LocalStorageBackend(storage, prefix);
  }

  tabKey(id: string): string {
    return this.tabPrefix + id;
  }

  async load(): Promise<LoadResult> {
    const json = this.storage.getItem(this.metaKey);
    if (json === null) return { status: 'empty' };
    let meta: PersistedMeta;
    try {
      meta = parseMeta(json);
    } catch (e) {
      if (e instanceof SchemaError) return { status: 'error', kind: e.kind, message: e.message };
      throw e;
    }
    const contents = new Map<string, string>();
    const missing: string[] = [];
    for (const tab of meta.tabs) {
      const content = this.storage.getItem(this.tabKey(tab.id));
      if (content === null) missing.push(tab.id);
      contents.set(tab.id, content ?? '');
    }
    return { status: 'ok', meta, contents, missing };
  }

  /** 現在保存されている revision */
  currentRevision(): { revision: number; writerId: string } | null {
    return peekRevision(this.storage.getItem(this.metaKey));
  }

  async write(batch: WriteBatch, options: WriteOptions): Promise<{ revision: number }> {
    return this.writeSync(batch, options);
  }

  /**
   * 同期的に書き込む。ページを閉じる直前（beforeunload / pagehide）でも結果を
   * その場で判定できるよう、内部処理には await を含めない。
   *
   * localStorage は複数キーをまとめて更新できないため、変更前の値を記録しておき、
   * 途中で失敗した場合は逆順に書き戻して、直前に保存した状態へ戻す。
   * 書き戻しは「以前に実際に保存できていた状態」へ戻る操作なので、容量超過では失敗しない。
   */
  writeSync(batch: WriteBatch, options: WriteOptions): { revision: number } {
    const current = this.currentRevision();
    const currentRevision = current?.revision ?? 0;
    if (!options.force && currentRevision !== options.expectedRevision) {
      throw new StorageConflictError(currentRevision, current?.writerId ?? '');
    }
    const revision = Math.max(currentRevision, options.expectedRevision) + 1;
    const undo: { key: string; value: string | null }[] = [];
    const set = (key: string, value: string | null) => {
      undo.push({ key, value: this.storage.getItem(key) });
      if (value === null) this.storage.removeItem(key);
      else this.storage.setItem(key, value);
    };
    try {
      // 先に削除して空き容量を確保する（失敗時は書き戻す）
      for (const id of batch.removed) set(this.tabKey(id), null);
      for (const [id, content] of batch.contents) set(this.tabKey(id), content);
      const meta: PersistedMeta = {
        ...batch.meta,
        schemaVersion: SCHEMA_VERSION,
        app: APP_ID,
        revision,
        writerId: options.writerId,
        savedAt: Date.now(),
      };
      set(this.metaKey, JSON.stringify(meta));
    } catch (e) {
      this.rollback(undo);
      if (isQuotaError(e)) throw new StorageQuotaError();
      throw e;
    }
    if (batch.pruneOrphans) this.pruneOrphans(new Set(batch.meta.tabs.map((t) => t.id)));
    return { revision };
  }

  /** 記録した変更前の値を逆順に書き戻す */
  private rollback(undo: { key: string; value: string | null }[]): void {
    for (let i = undo.length - 1; i >= 0; i--) {
      const { key, value } = undo[i];
      try {
        if (value === null) this.storage.removeItem(key);
        else this.storage.setItem(key, value);
      } catch (e) {
        // 通常は起きない。残りのキーの書き戻しは続ける
        console.error(`保存データの書き戻しに失敗しました: ${key}`, e);
      }
    }
  }

  /** meta から参照されていないタブ本文を削除する */
  pruneOrphans(keep: Set<string>): void {
    for (const key of this.ownKeys()) {
      if (key.startsWith(this.tabPrefix) && !keep.has(key.slice(this.tabPrefix.length))) {
        this.storage.removeItem(key);
      }
    }
  }

  private ownKeys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key !== null && key.startsWith(`${this.prefix}:`)) keys.push(key);
    }
    return keys;
  }

  subscribe(listener: (change: ExternalChange) => void): () => void {
    const handler = (e: StorageEvent) => {
      if (e.storageArea !== this.storage) return;
      if (e.key === null) {
        listener({ revision: null, writerId: null });
      } else if (e.key === this.metaKey) {
        const info = peekRevision(e.newValue);
        listener({ revision: info?.revision ?? null, writerId: info?.writerId ?? null });
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }

  async usage(): Promise<StorageUsage> {
    let appChars = 0;
    let totalChars = 0;
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key === null) continue;
      const size = key.length + (this.storage.getItem(key)?.length ?? 0);
      totalChars += size;
      if (key.startsWith(`${this.prefix}:`)) appChars += size;
    }
    return { appChars, totalChars, quotaChars: ESTIMATED_QUOTA_CHARS };
  }

  async dumpRaw(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of this.ownKeys()) out[key] = this.storage.getItem(key) ?? '';
    return out;
  }

  async clear(): Promise<void> {
    for (const key of this.ownKeys()) this.storage.removeItem(key);
  }
}
