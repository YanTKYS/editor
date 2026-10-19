import type { PersistedMeta, SchemaErrorKind } from './schema';

/**
 * 保存先の抽象インターフェース。
 * 現在は localStorage 実装のみだが、IndexedDB 等へ差し替えられるよう非同期 API としている。
 */
export interface StorageBackend {
  readonly name: string;
  /** 保存データを読み込む */
  load(): Promise<LoadResult>;
  /**
   * 変更を書き込む。expectedRevision が保存済みの revision と異なる場合は
   * StorageConflictError を送出する（force 指定時を除く）。
   */
  write(batch: WriteBatch, options: WriteOptions): Promise<{ revision: number }>;
  /** 他のブラウザタブによる書き込みを購読する */
  subscribe(listener: (change: ExternalChange) => void): () => void;
  /** 使用量の目安 */
  usage(): Promise<StorageUsage>;
  /** 復旧用に保存データをそのまま取り出す */
  dumpRaw(): Promise<Record<string, string>>;
  /** このアプリの保存データをすべて削除する */
  clear(): Promise<void>;
}

export interface WriteBatch {
  /** revision / writerId / savedAt は backend が設定する */
  meta: Omit<PersistedMeta, 'revision' | 'writerId' | 'savedAt'>;
  /** 変更されたタブの本文 */
  contents: Map<string, string>;
  /** 削除されたタブ ID */
  removed: string[];
  /** meta に含まれないタブ本文を削除する（強制上書き時） */
  pruneOrphans?: boolean;
}

export interface WriteOptions {
  writerId: string;
  expectedRevision: number;
  force?: boolean;
}

export type LoadResult =
  | { status: 'empty' }
  | { status: 'ok'; meta: PersistedMeta; contents: Map<string, string>; missing: string[] }
  | { status: 'error'; kind: SchemaErrorKind; message: string };

export interface ExternalChange {
  /** null の場合はデータが削除された */
  revision: number | null;
  writerId: string | null;
}

export interface StorageUsage {
  /** このアプリが使用している文字数 */
  appChars: number;
  /** オリジン全体で使用している文字数 */
  totalChars: number;
  /** 上限の目安（文字数）。不明なら null */
  quotaChars: number | null;
}

export class StorageQuotaError extends Error {
  constructor() {
    super('ブラウザの保存容量の上限を超えました。');
    this.name = 'StorageQuotaError';
  }
}

export class StorageConflictError extends Error {
  constructor(
    public readonly currentRevision: number,
    public readonly writerId: string,
  ) {
    super('別のブラウザタブで保存データが更新されています。');
    this.name = 'StorageConflictError';
  }
}

export class StorageUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('ブラウザ内保存（localStorage）を利用できません。');
    this.name = 'StorageUnavailableError';
    this.cause = cause;
  }
}
