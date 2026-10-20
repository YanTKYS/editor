import { Emitter } from '../core/emitter';
import {
  StorageConflictError,
  StorageQuotaError,
  type StorageBackend,
  type WriteBatch,
} from './backend';

export type SaveStatus =
  /** 保存済み（at: 最終保存時刻） */
  | { kind: 'saved'; at: number | null }
  /** 未保存の変更があり、保存待ち */
  | { kind: 'pending' }
  /** 保存に失敗した（変更はメモリ上に保持） */
  | { kind: 'error'; reason: 'quota' | 'unknown'; message: string }
  /** 他のブラウザタブが保存データを更新した */
  | { kind: 'conflict' }
  /** 保存データが壊れている・新しい形式のため、上書きを止めている */
  | { kind: 'blocked'; message: string }
  /** localStorage が利用できない */
  | { kind: 'unavailable' };

/** 保存データを組み立てるためにアプリ側が提供する情報 */
export interface SnapshotProvider {
  buildMeta(): WriteBatch['meta'];
  getContent(tabId: string): string;
}

interface PersistenceEvents extends Record<string, unknown> {
  status: SaveStatus;
}

export interface PersistenceOptions {
  /** 最後の入力から保存までの待ち時間（ms） */
  delay?: number;
  /** 入力が続いても、この時間（ms）が経過したら保存する */
  maxWait?: number;
  /** 保存失敗後、再試行までの最短間隔（ms） */
  retryDelay?: number;
}

/**
 * 自動保存の制御。変更をまとめてデバウンスし、変更されたタブの本文とメタ情報だけを書き込む。
 * 保存に失敗しても変更内容は破棄せず、次回の保存で再度書き込む。
 */
export class PersistenceController {
  readonly events = new Emitter<PersistenceEvents>();
  private dirtyTabs = new Set<string>();
  private removedTabs = new Set<string>();
  private metaDirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt: number | null = null;
  private lastFailureAt = 0;
  /** 完了待ちの非同期書き込みの数 */
  private inFlight = 0;
  private revision = 0;
  private suspended = false;
  private _status: SaveStatus = { kind: 'saved', at: null };
  private unsubscribe: (() => void) | null = null;
  private readonly delay: number;
  private readonly maxWait: number;
  private readonly retryDelay: number;

  constructor(
    private readonly backend: StorageBackend | null,
    private readonly provider: SnapshotProvider,
    readonly writerId: string,
    options: PersistenceOptions = {},
  ) {
    this.delay = options.delay ?? 800;
    this.maxWait = options.maxWait ?? 5000;
    this.retryDelay = options.retryDelay ?? 5000;
    if (!backend) this._status = { kind: 'unavailable' };
  }

  get status(): SaveStatus {
    return this._status;
  }

  get currentRevision(): number {
    return this.revision;
  }

  /** 未保存の変更があるか */
  /**
   * 保存が確定していない変更があるか。
   * 書き込み中（非同期の保存先で完了待ち）の変更も未保存として扱う。
   */
  get hasUnsavedChanges(): boolean {
    return this.hasPendingChanges || this.inFlight > 0;
  }

  /** まだ書き込みを開始していない変更があるか */
  private get hasPendingChanges(): boolean {
    return this.metaDirty || this.dirtyTabs.size > 0 || this.removedTabs.size > 0;
  }

  /**
   * 読み込み済みの revision を基準として、他タブの変更監視を開始する。
   * 読み込み処理中に記録された変更フラグは破棄する（読み込んだだけで書き込まないため）。
   */
  start(revision: number, savedAt: number | null = null): void {
    this.revision = revision;
    this.clearTimer();
    this.dirtyTabs.clear();
    this.removedTabs.clear();
    this.metaDirty = false;
    this.firstDirtyAt = null;
    this.setStatus({ kind: 'saved', at: savedAt });
    this.unsubscribe?.();
    this.unsubscribe =
      this.backend?.subscribe((change) => {
        if (change.writerId === this.writerId && change.revision === this.revision) return;
        if (change.revision !== this.revision) this.markConflict();
      }) ?? null;
  }

  /** 保存データの破損等により、利用者が判断するまで書き込みを止める */
  block(message: string): void {
    this.setStatus({ kind: 'blocked', message });
  }

  /** ページ再読み込み前などに、以後の保存をすべて止める */
  suspend(): void {
    this.suspended = true;
    this.clearTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  dispose(): void {
    this.suspend();
  }

  markTabDirty(id: string): void {
    this.removedTabs.delete(id);
    this.dirtyTabs.add(id);
    this.schedule();
  }

  markTabRemoved(id: string): void {
    this.dirtyTabs.delete(id);
    this.removedTabs.add(id);
    this.metaDirty = true;
    this.schedule();
  }

  markMetaDirty(): void {
    this.metaDirty = true;
    this.schedule();
  }

  /** すべてのタブを書き込み対象にする */
  markAllDirty(tabIds: Iterable<string>): void {
    for (const id of tabIds) this.dirtyTabs.add(id);
    this.metaDirty = true;
    this.schedule();
  }

  private canWrite(): boolean {
    if (this.suspended || !this.backend) return false;
    const k = this._status.kind;
    return k !== 'conflict' && k !== 'blocked' && k !== 'unavailable';
  }

  private schedule(): void {
    if (!this.backend || this.suspended) return;
    if (!this.hasPendingChanges) return;
    if (this._status.kind === 'saved') this.setStatus({ kind: 'pending' });
    if (!this.canWrite()) return;
    const now = Date.now();
    if (this.firstDirtyAt === null) this.firstDirtyAt = now;
    let wait = Math.min(this.delay, Math.max(0, this.firstDirtyAt + this.maxWait - now));
    if (this._status.kind === 'error') {
      wait = Math.max(wait, this.lastFailureAt + this.retryDelay - now);
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 未保存の変更を直ちに書き込む。
   * 保存先が同期書き込みに対応していれば（localStorage）、成功・失敗とそれに伴う状態
   * （未保存フラグ・status）は呼び出しから戻った時点で確定している。
   * そのため beforeunload では flush() の直後に hasUnsavedChanges を見ればよい。
   * @returns 保存に成功した（または保存すべき変更がない）場合 true
   */
  flush(options: { force?: boolean; pruneOrphans?: boolean } = {}): Promise<boolean> {
    this.clearTimer();
    const backend = this.backend;
    if (!backend || this.suspended) return Promise.resolve(false);
    if (!options.force && !this.canWrite()) return Promise.resolve(false);
    if (!this.hasPendingChanges && !options.force) {
      return Promise.resolve(true);
    }
    const dirty = [...this.dirtyTabs];
    const removed = [...this.removedTabs];
    const meta = this.provider.buildMeta();
    const liveIds = new Set(meta.tabs.map((t) => t.id));
    const contents = new Map<string, string>();
    for (const id of dirty) if (liveIds.has(id)) contents.set(id, this.provider.getContent(id));
    const batch: WriteBatch = { meta, contents, removed, pruneOrphans: options.pruneOrphans };
    const writeOptions = {
      writerId: this.writerId,
      expectedRevision: this.revision,
      force: options.force,
    };
    // 書き込み中に発生した変更を失わないよう、先に dirty をクリアしておき、失敗時に戻す
    this.dirtyTabs.clear();
    this.removedTabs.clear();
    this.metaDirty = false;
    this.firstDirtyAt = null;

    if (backend.writeSync) {
      try {
        this.onWriteSuccess(backend.writeSync(batch, writeOptions).revision);
        return Promise.resolve(true);
      } catch (e) {
        this.onWriteFailure(e, dirty, removed);
        return Promise.resolve(false);
      }
    }
    this.inFlight++;
    return backend.write(batch, writeOptions).then(
      ({ revision }) => {
        this.inFlight--;
        this.onWriteSuccess(revision);
        return true;
      },
      (e: unknown) => {
        this.inFlight--;
        this.onWriteFailure(e, dirty, removed);
        return false;
      },
    );
  }

  private onWriteSuccess(revision: number): void {
    this.revision = revision;
    if (this.hasPendingChanges) {
      this.setStatus({ kind: 'pending' });
      this.schedule();
    } else {
      this.setStatus({ kind: 'saved', at: Date.now() });
    }
  }

  /** 書き込めなかった変更を未保存として戻し、状態を更新する */
  private onWriteFailure(e: unknown, dirty: string[], removed: string[]): void {
    for (const id of dirty) if (!this.removedTabs.has(id)) this.dirtyTabs.add(id);
    for (const id of removed) if (!this.dirtyTabs.has(id)) this.removedTabs.add(id);
    this.metaDirty = true;
    this.lastFailureAt = Date.now();
    if (e instanceof StorageConflictError) {
      this.markConflict();
    } else if (e instanceof StorageQuotaError) {
      this.setStatus({ kind: 'error', reason: 'quota', message: e.message });
    } else {
      const message = e instanceof Error ? e.message : String(e);
      this.setStatus({ kind: 'error', reason: 'unknown', message });
    }
  }

  /** 競合時: このタブの内容で保存データを上書きする */
  overwrite(allTabIds: Iterable<string>): Promise<boolean> {
    for (const id of allTabIds) this.dirtyTabs.add(id);
    this.metaDirty = true;
    this.setStatus({ kind: 'pending' });
    return this.flush({ force: true, pruneOrphans: true });
  }

  private markConflict(): void {
    this.clearTimer();
    this.setStatus({ kind: 'conflict' });
  }

  private setStatus(status: SaveStatus): void {
    this._status = status;
    this.events.emit('status', status);
  }
}
