import { createId, Emitter } from './emitter';
import { detectMode } from './modes';
import type { TabMeta } from './types';

export type TabChange =
  | { type: 'add'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'update'; id: string; keys: (keyof TabMeta)[] }
  | { type: 'move'; id: string }
  | { type: 'activate'; id: string | null; previous: string | null }
  | { type: 'reset' };

interface TabStoreEvents extends Record<string, unknown> {
  change: TabChange;
}

const UNTITLED_PREFIX = '新規 ';

/**
 * タブの並び順・メタ情報・アクティブタブを管理するモデル。
 * DOM や CodeMirror には依存しない。
 */
export class TabStore {
  private tabs: TabMeta[] = [];
  private activeId: string | null = null;
  readonly events = new Emitter<TabStoreEvents>();

  get all(): readonly TabMeta[] {
    return this.tabs;
  }

  get count(): number {
    return this.tabs.length;
  }

  get active(): TabMeta | null {
    return this.activeId ? this.get(this.activeId) : null;
  }

  get activeTabId(): string | null {
    return this.activeId;
  }

  get(id: string): TabMeta | null {
    return this.tabs.find((t) => t.id === id) ?? null;
  }

  indexOf(id: string): number {
    return this.tabs.findIndex((t) => t.id === id);
  }

  /** 全タブを置き換える（復元・バックアップからの読み込み用） */
  reset(tabs: TabMeta[], activeId: string | null): void {
    this.tabs = tabs.map((t) => ({ ...t }));
    this.activeId =
      activeId && this.tabs.some((t) => t.id === activeId) ? activeId : (this.tabs[0]?.id ?? null);
    this.events.emit('change', { type: 'reset' });
  }

  /** 未使用の「新規 n」の名前を返す */
  nextUntitledName(): string {
    const used = new Set<number>();
    for (const t of this.tabs) {
      if (t.name.startsWith(UNTITLED_PREFIX)) {
        const n = Number(t.name.slice(UNTITLED_PREFIX.length));
        if (Number.isInteger(n)) used.add(n);
      }
    }
    let n = 1;
    while (used.has(n)) n++;
    return `${UNTITLED_PREFIX}${n}`;
  }

  /** タブを作成する。index 未指定なら末尾に追加 */
  create(init: Partial<TabMeta> = {}, index?: number): TabMeta {
    const now = Date.now();
    const name = init.name ?? this.nextUntitledName();
    const tab: TabMeta = {
      id: init.id ?? createId(),
      name,
      mode: init.mode ?? detectMode(name),
      eol: init.eol ?? 'LF',
      encoding: init.encoding ?? 'UTF-8',
      bom: init.bom ?? false,
      modifiedSinceFile: init.modifiedSinceFile ?? false,
      createdAt: init.createdAt ?? now,
      updatedAt: init.updatedAt ?? now,
    };
    const at = index === undefined ? this.tabs.length : Math.max(0, Math.min(index, this.tabs.length));
    this.tabs.splice(at, 0, tab);
    this.events.emit('change', { type: 'add', id: tab.id });
    return tab;
  }

  /**
   * タブを削除する。アクティブタブを削除した場合は右隣（なければ左隣）をアクティブにする。
   * 戻り値は新しいアクティブタブ ID。
   */
  remove(id: string): string | null {
    const idx = this.indexOf(id);
    if (idx < 0) return this.activeId;
    this.tabs.splice(idx, 1);
    this.events.emit('change', { type: 'remove', id });
    if (this.activeId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      this.activate(next ? next.id : null);
    }
    return this.activeId;
  }

  update(id: string, patch: Partial<Omit<TabMeta, 'id'>>): void {
    const tab = this.get(id);
    if (!tab) return;
    const keys: (keyof TabMeta)[] = [];
    for (const key of Object.keys(patch) as (keyof Omit<TabMeta, 'id'>)[]) {
      if (patch[key] !== undefined && tab[key] !== patch[key]) {
        (tab as unknown as Record<string, unknown>)[key] = patch[key];
        keys.push(key);
      }
    }
    if (keys.length) this.events.emit('change', { type: 'update', id, keys });
  }

  /** 名前を変更する。空白のみの名前は無視して false を返す */
  rename(id: string, name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) return false;
    this.update(id, { name: trimmed, updatedAt: Date.now() });
    return true;
  }

  /** タブを指定位置へ移動する */
  move(id: string, toIndex: number): void {
    const from = this.indexOf(id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(toIndex, this.tabs.length - 1));
    if (from === to) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.events.emit('change', { type: 'move', id });
  }

  activate(id: string | null): void {
    if (id !== null && !this.get(id)) return;
    if (this.activeId === id) return;
    const previous = this.activeId;
    this.activeId = id;
    this.events.emit('change', { type: 'activate', id, previous });
  }

  /** 隣のタブの ID（offset = 1 で次、-1 で前。端では折り返す） */
  neighbor(offset: number): string | null {
    if (!this.tabs.length) return null;
    const idx = this.activeId ? this.indexOf(this.activeId) : 0;
    const n = this.tabs.length;
    return this.tabs[(((idx + offset) % n) + n) % n].id;
  }
}
