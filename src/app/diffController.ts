import { computeDiff, mapLine, type DiffResult } from '../core/diff';
import { Emitter } from '../core/emitter';
import type { PaneLayout, PaneLayoutState } from '../core/paneLayout';
import type { TabStore } from '../core/tabStore';
import { buildDiffMarks } from '../editor/diffMarks';
import type { EditorManager } from '../editor/editorManager';

/** 比較の対象: 比較元（A）と比較先（B）のタブと、それを表示するペイン */
export interface DiffTargets {
  a: string;
  b: string;
  paneA: number;
  paneB: number;
}

/** 画面に表示するための比較の状態 */
export interface DiffStatus {
  a: string;
  b: string;
  paneA: number;
  paneB: number;
  added: number;
  deleted: number;
  changed: number;
  total: number;
  /** 前後移動で選択中の差分（0 始まり。未選択は -1） */
  current: number;
  precise: boolean;
}

interface Session extends DiffTargets {
  /** 比較開始前のペイン配置（比較終了時に復元する） */
  prev: PaneLayoutState;
  /** 比較開始時点の分割数 */
  startCount: number;
  result: DiffResult;
  current: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 次の再計算までの待ち時間（計算が重いほど長くする） */
  delay: number;
  /** プログラムによるスクロールで発生した scroll イベントを無視するための、設定済みのスクロール位置 */
  expected: { a: number | null; b: number | null };
}

interface DiffEvents extends Record<string, unknown> {
  change: void;
}

export interface DiffHost {
  layout: PaneLayout;
  store: TabStore;
  editor: EditorManager;
  /** 利用者への通知 */
  notify(message: string): void;
}

const MIN_DELAY = 200;
const MAX_DELAY = 1500;
/** 差分へ移動したとき、画面上端から差分の先頭までに空ける割合 */
const JUMP_MARGIN = 0.25;

/**
 * 差分比較の進行を管理する。タブ・本文・ペインの配置は既存のモデルをそのまま使い、
 * 差分の強調表示（各タブの EditorState の装飾）とスクロール同期だけを追加する。
 * タブの本文は変更せず、比較の状態は保存しない。
 */
export class DiffController {
  readonly events = new Emitter<DiffEvents>();
  private session: Session | null = null;
  /** 自分が行ったペイン配置の変更（比較の終了判定の対象外） */
  private ownLayoutChange = false;

  constructor(private readonly host: DiffHost) {
    host.layout.events.on('change', () => this.onLayoutChange());
  }

  get active(): boolean {
    return this.session !== null;
  }

  get status(): DiffStatus | null {
    const s = this.session;
    if (!s) return null;
    const { result } = s;
    return {
      a: s.a,
      b: s.b,
      paneA: s.paneA,
      paneB: s.paneB,
      added: result.added,
      deleted: result.deleted,
      changed: result.changed,
      total: result.blocks.length,
      current: s.current,
      precise: result.precise,
    };
  }

  /** 比較に使うペイン（比較中でなければ null） */
  get panes(): { a: number; b: number } | null {
    return this.session ? { a: this.session.paneA, b: this.session.paneB } : null;
  }

  /** 検証。問題があればメッセージを返す */
  validate(t: DiffTargets): string | null {
    const { store, layout } = this.host;
    if (t.a === t.b) return '同じタブ同士は比較できません。別のタブを選んでください。';
    if (!store.get(t.a) || !store.get(t.b)) return '比較するタブが見つかりません。';
    const count = Math.max(layout.count, 2);
    if (t.paneA === t.paneB || t.paneA < 0 || t.paneB < 0 || t.paneA >= count || t.paneB >= count) {
      return '比較する 2 つのペインを別々に指定してください。';
    }
    return null;
  }

  /**
   * 比較を開始する。1 画面なら 2 分割にする。比較中に呼ぶと、比較開始前の配置を保ったまま比較対象を変更する。
   * @returns 開始できなければ false
   */
  start(targets: DiffTargets): boolean {
    if (this.validate(targets)) return false;
    const { layout, store, editor } = this.host;
    const prev = this.session?.prev ?? layout.toJSON();
    this.clearMarks(this.session);
    this.stopTimer();
    this.session = null;

    this.ownLayoutChange = true;
    try {
      if (layout.count < 2) layout.setCount(2, store.all.map((t) => t.id));
      // 先に配置してから比較元・比較先を表示する（既存のタブを使い、複製しない）
      layout.show(targets.a, targets.paneA, false);
      layout.show(targets.b, targets.paneB, false);
      layout.setActive(targets.paneA);
    } finally {
      this.ownLayoutChange = false;
    }

    this.session = {
      ...targets,
      prev,
      startCount: layout.count,
      result: { blocks: [], added: 0, deleted: 0, changed: 0, precise: true },
      current: -1,
      timer: null,
      delay: MIN_DELAY,
      expected: { a: null, b: null },
    };
    const session = this.session;
    this.recompute();
    if (session.result.blocks.length) {
      session.current = 0;
      this.applyMarks(session);
      // ペインの寸法が確定してから、最初の差分へスクロールする
      editor.requestMeasure();
      requestAnimationFrame(() => {
        if (this.session === session) this.scrollToCurrent(session);
      });
    }
    this.events.emit('change', undefined);
    return true;
  }

  /**
   * 比較を終了して強調表示とスクロール同期を解除する。
   * restore = true なら、比較開始前のペイン数・タブ配置・アクティブなペインに戻す
   * （比較中に分割数を変えた場合は、利用者の操作を優先して戻さない）。本文の編集内容は常にそのまま残る。
   */
  end(restore = true): void {
    const s = this.session;
    if (!s) return;
    this.stopTimer();
    this.clearMarks(s);
    this.session = null;
    if (restore && this.host.layout.count === s.startCount) this.restoreLayout(s.prev);
    this.events.emit('change', undefined);
  }

  /* ---------- 差分の前後移動 ---------- */

  next(): void {
    const s = this.session;
    if (s?.result.blocks.length) this.goTo((s.current + 1) % s.result.blocks.length);
  }

  previous(): void {
    const s = this.session;
    if (!s?.result.blocks.length) return;
    const n = s.result.blocks.length;
    this.goTo(s.current <= 0 ? n - 1 : s.current - 1);
  }

  /** 指定の差分を現在の差分にして、両方のペインでその位置を表示する */
  goTo(index: number): void {
    const s = this.session;
    if (!s?.result.blocks[index]) return;
    s.current = index;
    this.applyMarks(s);
    this.scrollToCurrent(s);
    this.events.emit('change', undefined);
  }

  private scrollToCurrent(s: Session): void {
    const blk = s.result.blocks[s.current];
    if (!blk) return;
    const { editor } = this.host;
    const place = (id: string, pane: 'a' | 'b', line: number) => {
      const margin = editor.getViewportHeight(id) * JUMP_MARGIN;
      s.expected[pane] = editor.setScrollTop(id, editor.scrollTopForLine(id, line, margin));
    };
    place(s.a, 'a', blk.startLineA);
    place(s.b, 'b', blk.startLineB);
  }

  /* ---------- 編集・スクロールへの追従 ---------- */

  /** 本文が変更された（比較中のタブなら、少し遅れて差分を再計算する） */
  onDocChange(id: string): void {
    const s = this.session;
    if (!s || (id !== s.a && id !== s.b)) return;
    if (s.timer !== null) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      if (this.session === s) this.recompute();
    }, s.delay);
  }

  /** 比較中のペインがスクロールされたら、もう一方を対応する位置にそろえる */
  onScroll(id: string): void {
    const s = this.session;
    if (!s || (id !== s.a && id !== s.b)) return;
    const from = id === s.a ? 'a' : 'b';
    const to = from === 'a' ? 'b' : 'a';
    const { editor } = this.host;
    // 自分でスクロールした結果として届いたイベントは無視する（互いに追いかけ合わない）
    const expected = s.expected[from];
    if (expected !== null) {
      s.expected[from] = null;
      if (Math.abs(editor.getScrollTop(id) - expected) <= 1.5) return;
    }
    const line = editor.getTopLine(id);
    if (line === null) return;
    const otherId = to === 'a' ? s.a : s.b;
    const target = editor.scrollTopForLine(otherId, mapLine(s.result.blocks, from, line));
    if (Math.abs(editor.getScrollTop(otherId) - target) < 1) return;
    s.expected[to] = editor.setScrollTop(otherId, target);
  }

  /* ---------- 内部処理 ---------- */

  private recompute(): void {
    const s = this.session;
    if (!s) return;
    const { editor } = this.host;
    const a = editor.getState(s.a)?.doc;
    const b = editor.getState(s.b)?.doc;
    if (!a || !b) {
      this.fail('比較中のタブが見つからないため、差分比較を終了しました。');
      return;
    }
    const t0 = performance.now();
    s.result = computeDiff(a, b);
    s.delay = Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round((performance.now() - t0) * 3)));
    if (s.current >= s.result.blocks.length) s.current = s.result.blocks.length - 1;
    this.applyMarks(s);
    this.events.emit('change', undefined);
  }

  private applyMarks(s: Session): void {
    const { editor } = this.host;
    const a = editor.getState(s.a)?.doc;
    const b = editor.getState(s.b)?.doc;
    if (!a || !b) return;
    editor.setDiffMarks(s.a, buildDiffMarks(s.result, 'a', a, s.current));
    editor.setDiffMarks(s.b, buildDiffMarks(s.result, 'b', b, s.current));
  }

  private clearMarks(s: Session | null): void {
    if (!s) return;
    for (const id of [s.a, s.b]) if (this.host.editor.hasTab(id)) this.host.editor.setDiffMarks(id, null);
  }

  private stopTimer(): void {
    if (this.session?.timer != null) clearTimeout(this.session.timer);
    if (this.session) this.session.timer = null;
  }

  /** 比較を続けられなくなったので終了する（配置は利用者の操作の結果をそのまま残す） */
  private fail(message: string): void {
    this.end(false);
    this.host.notify(message);
  }

  private onLayoutChange(): void {
    const s = this.session;
    if (!s || this.ownLayoutChange) return;
    const { layout, store } = this.host;
    const alive = store.get(s.a) && store.get(s.b);
    if (!alive) return this.fail('比較中のタブが閉じられたため、差分比較を終了しました。');
    if (layout.tabs[s.paneA] !== s.a || layout.tabs[s.paneB] !== s.b) {
      this.fail('比較中のペインの表示が変わったため、差分比較を終了しました。');
    }
  }

  /** 比較開始前の配置に戻す。比較中に閉じたタブは、現在表示しているタブで補う */
  private restoreLayout(prev: PaneLayoutState): void {
    const { layout, store } = this.host;
    const valid = new Set(store.all.map((t) => t.id));
    const used = new Set<string>();
    const tabs = prev.tabs.map((id, i) => {
      let pick: string | null = id !== null && valid.has(id) ? id : null;
      if (pick === null) {
        const cur = layout.tabs[i];
        if (cur && valid.has(cur)) pick = cur;
      }
      if (pick !== null && used.has(pick)) pick = null;
      if (pick !== null) used.add(pick);
      return pick;
    });
    this.ownLayoutChange = true;
    try {
      layout.load({ count: prev.count, tabs, active: prev.active }, valid);
    } finally {
      this.ownLayoutChange = false;
    }
  }
}
