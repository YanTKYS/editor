/**
 * テスト用の Storage 実装。容量制限と、特定キーへの書き込み失敗を再現できる。
 */
export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  /** 書き込み前に呼ばれ、Error を返すとその書き込みを失敗させる */
  failOn: ((key: string, value: string | null) => Error | null) | null = null;

  constructor(public quotaChars = Infinity) {}

  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    const err = this.failOn?.(k, v);
    if (err) throw err;
    let used = 0;
    for (const [key, val] of this.map) if (key !== k) used += key.length + val.length;
    if (used + k.length + v.length > this.quotaChars) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    const err = this.failOn?.(k, null);
    if (err) throw err;
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  /** 全キーのスナップショット（比較用） */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.map].sort(([a], [b]) => a.localeCompare(b)));
  }
}
