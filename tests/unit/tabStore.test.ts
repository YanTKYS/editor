import { describe, expect, it } from 'vitest';
import { TabStore, type TabChange } from '../../src/core/tabStore';

describe('TabStore', () => {
  it('新規タブに連番の名前を付ける', () => {
    const s = new TabStore();
    expect(s.create().name).toBe('新規 1');
    const t2 = s.create();
    expect(t2.name).toBe('新規 2');
    s.remove(s.all[0].id);
    expect(s.create().name).toBe('新規 1');
  });

  it('名前から編集モードを判定する', () => {
    const s = new TabStore();
    expect(s.create({ name: 'a.md' }).mode).toBe('markdown');
  });

  it('アクティブタブを閉じると右隣（なければ左隣）をアクティブにする', () => {
    const s = new TabStore();
    const [a, b, c] = [s.create(), s.create(), s.create()];
    s.activate(b.id);
    expect(s.remove(b.id)).toBe(c.id);
    expect(s.remove(c.id)).toBe(a.id);
    expect(s.remove(a.id)).toBeNull();
  });

  it('並べ替え・次/前のタブ', () => {
    const s = new TabStore();
    const [a, b, c] = [s.create(), s.create(), s.create()];
    s.move(a.id, 2);
    expect(s.all.map((t) => t.id)).toEqual([b.id, c.id, a.id]);
    s.activate(a.id);
    expect(s.neighbor(1)).toBe(b.id);
    expect(s.neighbor(-1)).toBe(c.id);
  });

  it('名前変更は空白のみを拒否する', () => {
    const s = new TabStore();
    const t = s.create();
    expect(s.rename(t.id, '   ')).toBe(false);
    expect(s.rename(t.id, ' 議事録.txt ')).toBe(true);
    expect(s.get(t.id)?.name).toBe('議事録.txt');
  });

  it('変更イベントを通知する', () => {
    const s = new TabStore();
    const events: TabChange['type'][] = [];
    s.events.on('change', (c) => events.push(c.type));
    const t = s.create();
    s.activate(t.id);
    s.update(t.id, { mode: 'json' });
    s.update(t.id, { mode: 'json' }); // 変化なし
    s.remove(t.id);
    expect(events).toEqual(['add', 'activate', 'update', 'remove', 'activate']);
  });
});
