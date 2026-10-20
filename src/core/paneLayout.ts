import { Emitter } from './emitter';

export const MAX_PANES = 4;

/** 保存用のペイン配置 */
export interface PaneLayoutState {
  /** 分割数（1〜4） */
  count: number;
  /** 各ペインに表示しているタブ ID（空のペインは null）。長さは count */
  tabs: (string | null)[];
  /** アクティブなペインの番号（0 始まり） */
  active: number;
}

interface PaneLayoutEvents extends Record<string, unknown> {
  change: void;
}

export function isPaneCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_PANES;
}

/**
 * 画面分割（ペイン）の配置を管理するモデル。DOM や CodeMirror には依存しない。
 * - 各タブは高々 1 つのペインにだけ表示する
 * - 分割数を減らしても、閉じたペインのタブ自体は削除しない（表示されなくなるだけ）
 */
export class PaneLayout {
  readonly events = new Emitter<PaneLayoutEvents>();
  private _count = 1;
  private _tabs: (string | null)[] = [null];
  private _active = 0;

  get count(): number {
    return this._count;
  }

  get tabs(): readonly (string | null)[] {
    return this._tabs;
  }

  get active(): number {
    return this._active;
  }

  /** アクティブなペインに表示しているタブ */
  get activeTabId(): string | null {
    return this._tabs[this._active] ?? null;
  }

  /** タブを表示しているペインの番号（表示していなければ -1） */
  paneOf(tabId: string): number {
    return this._tabs.indexOf(tabId);
  }

  toJSON(): PaneLayoutState {
    return { count: this._count, tabs: [...this._tabs], active: this._active };
  }

  /**
   * 保存データから読み込む。存在しないタブ・重複・範囲外の値は補正する。
   * silent = true の場合は change を通知しない。
   */
  load(state: Partial<PaneLayoutState> | null | undefined, validIds: Iterable<string>, silent = false): void {
    const valid = new Set(validIds);
    const count = isPaneCount(state?.count) ? state.count : 1;
    const seen = new Set<string>();
    const tabs: (string | null)[] = [];
    for (let i = 0; i < count; i++) {
      const id = state?.tabs?.[i];
      if (typeof id === 'string' && valid.has(id) && !seen.has(id)) {
        seen.add(id);
        tabs.push(id);
      } else {
        tabs.push(null);
      }
    }
    const active = state?.active;
    this._count = count;
    this._tabs = tabs;
    this._active = typeof active === 'number' && Number.isInteger(active) && active >= 0 && active < count ? active : 0;
    if (!silent) this.emit();
  }

  /** 存在しなくなったタブをペインから外す */
  reconcile(validIds: Iterable<string>): void {
    const valid = new Set(validIds);
    let changed = false;
    this._tabs = this._tabs.map((id) => {
      if (id !== null && !valid.has(id)) {
        changed = true;
        return null;
      }
      return id;
    });
    if (changed) this.emit();
  }

  /**
   * 分割数を変更する。
   * 増やす場合は、表示していないタブをタブの並び順に新しいペインへ割り当てる
   * （最後に表示していたタブの次から順に）。
   * 減らす場合は、後ろのペインの表示領域だけを閉じる（タブは削除しない）。
   */
  setCount(count: number, orderedTabIds: readonly string[]): void {
    if (!isPaneCount(count) || count === this._count) return;
    if (count < this._count) {
      this._tabs = this._tabs.slice(0, count);
      if (this._active >= count) this._active = count - 1;
    } else {
      const displayed = new Set(this._tabs.filter((id): id is string => id !== null));
      let start = 0;
      for (let i = orderedTabIds.length - 1; i >= 0; i--) {
        if (displayed.has(orderedTabIds[i])) {
          start = i + 1;
          break;
        }
      }
      const queue: string[] = [];
      for (let k = 0; k < orderedTabIds.length; k++) {
        const id = orderedTabIds[(start + k) % orderedTabIds.length];
        if (!displayed.has(id)) queue.push(id);
      }
      while (this._tabs.length < count) this._tabs.push(queue.shift() ?? null);
    }
    this._count = count;
    this.emit();
  }

  /**
   * タブをペインに表示する（他のペインに表示中なら、そちらからは外す）。
   * activate = true ならそのペインをアクティブにする。
   */
  show(tabId: string | null, pane = this._active, activate = true): void {
    if (pane < 0 || pane >= this._count) return;
    const prev = tabId === null ? -1 : this.paneOf(tabId);
    if (prev === pane && (!activate || this._active === pane)) return;
    if (prev >= 0) this._tabs[prev] = null;
    this._tabs[pane] = tabId;
    if (activate) this._active = pane;
    this.emit();
  }

  setActive(pane: number): void {
    if (pane < 0 || pane >= this._count || pane === this._active) return;
    this._active = pane;
    this.emit();
  }

  /**
   * タブの削除に合わせてペインを更新する。
   * そのタブを表示していたペインには、削除位置に近い（右隣、なければ左隣の）
   * 表示していないタブを表示する。該当するタブがなければ空のペインにする。
   * @param orderedTabIds 削除後のタブの並び
   * @param removedIndex 削除されたタブがあった位置
   */
  removeTab(tabId: string, orderedTabIds: readonly string[], removedIndex: number): void {
    const pane = this.paneOf(tabId);
    if (pane < 0) return;
    const displayed = new Set(this._tabs.filter((id): id is string => id !== null && id !== tabId));
    let replacement: string | null = null;
    for (let i = removedIndex; i < orderedTabIds.length && !replacement; i++) {
      if (!displayed.has(orderedTabIds[i])) replacement = orderedTabIds[i];
    }
    for (let i = Math.min(removedIndex, orderedTabIds.length) - 1; i >= 0 && !replacement; i--) {
      if (!displayed.has(orderedTabIds[i])) replacement = orderedTabIds[i];
    }
    this._tabs[pane] = replacement;
    this.emit();
  }

  private emit(): void {
    this.events.emit('change', undefined);
  }
}
