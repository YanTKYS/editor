import { computeDiff, formatUnified, type DiffResult, type UnifiedDiff } from '../core/diff';
import { Emitter } from '../core/emitter';
import type { PaneLayout, PaneLayoutState } from '../core/paneLayout';
import type { TabStore } from '../core/tabStore';
import { buildDiffMarks } from '../editor/diffMarks';
import { currentSpec, resultExtensions, unifiedSpec } from '../editor/diffResult';
import type { EditorManager } from '../editor/editorManager';

/** 比較の指定: 比較元・比較先・結果表示の 3 つのペイン（0 始まり）。比較するタブは各ペインに表示中のタブ */
export interface DiffTargets {
  a: number;
  b: number;
  result: number;
}

/** 画面に表示するための比較の状態 */
export interface DiffStatus extends DiffTargets {
  /** 比較元・比較先のタブ */
  aTab: string;
  bTab: string;
  added: number;
  deleted: number;
  changed: number;
  total: number;
  /** 選択中の差分（0 始まり。未選択は -1） */
  current: number;
  precise: boolean;
}

/** 比較に必要な最小のペイン数（比較元・比較先・結果表示） */
export const DIFF_MIN_PANES = 3;

interface Session extends DiffTargets {
  aTab: string;
  bTab: string;
  /** 結果表示のために一時的に外した、結果表示ペインのタブ（なければ null） */
  hiddenTab: string | null;
  /** 比較開始前のペイン配置（比較終了時に復元する） */
  prev: PaneLayoutState;
  /** 比較開始時点の分割数（拡張後） */
  startCount: number;
  diff: DiffResult;
  unified: UnifiedDiff;
  current: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 次の再計算までの待ち時間（計算が重いほど長くする） */
  delay: number;
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

/**
 * 差分比較の進行を管理する。
 * 比較元・比較先は既存のペインに表示中のタブをそのまま使い、差分結果だけを 3 つ目のペインに
 * 一時的な読み取り専用ビューとして表示する。タブの本文・Undo 履歴は変更せず、比較の状態は保存しない。
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
    return {
      a: s.a,
      b: s.b,
      result: s.result,
      aTab: s.aTab,
      bTab: s.bTab,
      added: s.diff.added,
      deleted: s.diff.deleted,
      changed: s.diff.changed,
      total: s.diff.blocks.length,
      current: s.current,
      precise: s.diff.precise,
    };
  }

  /** 保存用のペイン配置。比較中は、結果表示のために外したタブを元のペインに戻した配置にする */
  layoutForSave(): PaneLayoutState {
    const state = this.host.layout.toJSON();
    const s = this.session;
    if (s?.hiddenTab && state.tabs[s.result] === null && this.host.store.get(s.hiddenTab)) {
      state.tabs[s.result] = s.hiddenTab;
    }
    return state;
  }

  /* ---------- 比較の開始・終了 ---------- */

  /**
   * ダイアログに表示する、比較開始後のペイン配置（各ペインに表示するタブ。空は null）。
   * 3・4 分割はそのまま。1・2 分割は、3 ペインに拡張した配置にし、空の比較元・比較先には
   * 表示していない別のタブを割り当てる。結果表示用のペインは空のままにする。
   */
  planLayout(): (string | null)[] {
    const { layout, store } = this.host;
    const valid = (id: string | null): id is string => id !== null && !!store.get(id);
    const s = this.session;
    if (s) {
      // 比較中: 結果表示のために外したタブも含めて、元の配置を示す
      const tabs = [...layout.tabs];
      tabs[s.result] = s.hiddenTab && valid(s.hiddenTab) ? s.hiddenTab : null;
      return tabs;
    }
    const tabs = [...layout.tabs];
    if (tabs.length >= DIFF_MIN_PANES) return tabs;
    while (tabs.length < DIFF_MIN_PANES) tabs.push(null);
    const ids = store.all.map((t) => t.id);
    const shown = new Set(tabs.filter(valid));
    const anchor = ids.indexOf(tabs[0] ?? tabs[1] ?? '');
    // 内容のあるタブを優先し、現在のタブの次から順に割り当てる
    const ordered = [...ids.slice(anchor + 1), ...ids.slice(0, Math.max(anchor, 0) + 1)].filter((id) => !shown.has(id));
    const spare = [...ordered.filter((id) => this.host.editor.getLength(id) > 0), ...ordered.filter((id) => this.host.editor.getLength(id) === 0)];
    for (const i of [0, 1]) if (tabs[i] === null && spare.length) tabs[i] = spare.shift() ?? null;
    return tabs;
  }

  /** ダイアログの初期値 */
  defaultTargets(plan: readonly (string | null)[]): DiffTargets {
    const { layout } = this.host;
    const s = this.session;
    if (s) return { a: s.a, b: s.b, result: s.result };
    if (layout.count < DIFF_MIN_PANES) return { a: 0, b: 1, result: 2 };
    const n = plan.length;
    const withTab = plan.map((id, i) => (id ? i : -1)).filter((i) => i >= 0);
    const a = plan[layout.active] ? layout.active : (withTab[0] ?? 0);
    const others = Array.from({ length: n - 1 }, (_, k) => (a + 1 + k) % n);
    const b = others.find((i) => plan[i]) ?? others[0];
    const rest = others.filter((i) => i !== b);
    const result = rest.find((i) => !plan[i]) ?? rest[0];
    return { a, b, result };
  }

  /** 検証。問題があればメッセージを返す */
  validate(t: DiffTargets, plan: readonly (string | null)[]): string | null {
    const panes = [t.a, t.b, t.result];
    if (panes.some((p) => !Number.isInteger(p) || p < 0 || p >= plan.length)) return 'ペインを指定してください。';
    if (new Set(panes).size !== panes.length) {
      return '比較元・比較先・結果表示には、それぞれ別のペインを指定してください。';
    }
    for (const [label, pane] of [['比較元', t.a], ['比較先', t.b]] as const) {
      if (!plan[pane]) return `${label}（ペイン ${pane + 1}）にはタブが表示されていません。比較するタブを表示してください。`;
    }
    return null;
  }

  /**
   * 比較を開始する。ペインが 3 つ未満なら 3 ペインに拡張する（plan の配置にする）。
   * 比較中に呼ぶと、比較開始前の配置を保ったまま指定を変更する。
   * @returns 開始できなければ false（その場合、ペイン配置は変更しない）
   */
  start(targets: DiffTargets, plan: readonly (string | null)[]): boolean {
    if (this.validate(targets, plan)) return false;
    const { layout, store, editor } = this.host;
    const prev = this.session?.prev ?? layout.toJSON();
    if (this.session) {
      this.teardown(this.session, true);
      this.session = null;
    }

    this.ownLayoutChange = true;
    let hiddenTab: string | null;
    try {
      if (layout.count < DIFF_MIN_PANES) {
        layout.setCount(DIFF_MIN_PANES, store.all.map((t) => t.id), false);
        for (let i = 0; i < DIFF_MIN_PANES; i++) {
          const id = plan[i];
          if (id && layout.tabs[i] !== id) layout.show(id, i, false);
        }
      }
      hiddenTab = layout.tabs[targets.result] ?? null;
      if (hiddenTab !== null) layout.show(null, targets.result, false);
      layout.setActive(targets.a);
    } finally {
      this.ownLayoutChange = false;
    }

    const aTab = layout.tabs[targets.a];
    const bTab = layout.tabs[targets.b];
    const a = aTab ? editor.getState(aTab)?.doc : null;
    const b = bTab ? editor.getState(bTab)?.doc : null;
    if (!aTab || !bTab || !a || !b) {
      this.restoreLayout(prev);
      return false;
    }
    const diff = computeDiff(a, b);
    const unified = formatUnified(diff, a, b);
    const session: Session = {
      ...targets,
      aTab,
      bTab,
      hiddenTab,
      prev,
      startCount: layout.count,
      diff,
      unified,
      current: diff.blocks.length ? 0 : -1,
      timer: null,
      delay: MIN_DELAY,
    };
    this.session = session;
    editor.openOverlay(
      targets.result,
      unified.text,
      resultExtensions(unified, (block) => this.goTo(block, false)),
    );
    this.applyView(session);
    if (session.current >= 0) this.revealSources(session);
    editor.requestMeasure();
    this.events.emit('change', undefined);
    return true;
  }

  /**
   * 比較を終了して差分結果の表示と強調表示を解除する。
   * restore = true なら、比較開始前のペイン数・タブ配置・アクティブなペインに戻す
   * （比較中に分割数を変えた場合は、利用者の操作を優先して戻さない）。本文の編集内容は常にそのまま残る。
   */
  end(restore = true): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.teardown(s, true);
    if (restore && this.host.layout.count === s.startCount) this.restoreLayout(s.prev);
    this.events.emit('change', undefined);
  }

  /* ---------- 差分の前後移動 ---------- */

  next(): void {
    const s = this.session;
    if (s?.diff.blocks.length) this.goTo((s.current + 1) % s.diff.blocks.length);
  }

  previous(): void {
    const s = this.session;
    if (!s?.diff.blocks.length) return;
    const n = s.diff.blocks.length;
    this.goTo(s.current <= 0 ? n - 1 : s.current - 1);
  }

  /**
   * 指定の差分を選択し、比較元・比較先の対応する位置を表示する。
   * scrollResult = true なら結果表示も、その差分が見える位置へスクロールする。
   */
  goTo(index: number, scrollResult = true): void {
    const s = this.session;
    if (!s?.diff.blocks[index]) return;
    s.current = index;
    this.applyMarks(s);
    this.host.editor.updateOverlay(s.result, (state) => currentSpec(state, s.unified, index, scrollResult));
    this.revealSources(s);
    this.events.emit('change', undefined);
  }

  /* ---------- 編集への追従 ---------- */

  /** 本文が変更された（比較中のタブなら、少し遅れて差分を再計算する） */
  onDocChange(id: string): void {
    const s = this.session;
    if (!s || (id !== s.aTab && id !== s.bTab)) return;
    if (s.timer !== null) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      if (this.session === s) this.recompute();
    }, s.delay);
  }

  /* ---------- 内部処理 ---------- */

  private recompute(): void {
    const s = this.session;
    if (!s) return;
    const a = this.host.editor.getState(s.aTab)?.doc;
    const b = this.host.editor.getState(s.bTab)?.doc;
    if (!a || !b) {
      this.fail('比較中のタブが見つからないため、差分比較を終了しました。');
      return;
    }
    const t0 = performance.now();
    s.diff = computeDiff(a, b);
    s.unified = formatUnified(s.diff, a, b);
    s.delay = Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round((performance.now() - t0) * 3)));
    if (s.current >= s.diff.blocks.length) s.current = s.diff.blocks.length - 1;
    this.applyView(s);
    this.events.emit('change', undefined);
  }

  /** 差分結果の表示と、比較元・比較先の強調表示を更新する */
  private applyView(s: Session): void {
    this.applyMarks(s);
    this.host.editor.updateOverlay(s.result, (state) => unifiedSpec(state, s.unified, s.current));
  }

  private applyMarks(s: Session): void {
    const { editor } = this.host;
    const a = editor.getState(s.aTab)?.doc;
    const b = editor.getState(s.bTab)?.doc;
    if (!a || !b) return;
    editor.setDiffMarks(s.aTab, buildDiffMarks(s.diff, 'a', a, s.current));
    editor.setDiffMarks(s.bTab, buildDiffMarks(s.diff, 'b', b, s.current));
  }

  private revealSources(s: Session): void {
    const blk = s.diff.blocks[s.current];
    if (!blk) return;
    this.host.editor.revealLine(s.aTab, blk.startLineA);
    this.host.editor.revealLine(s.bTab, blk.startLineB);
  }

  /** 比較の表示を片付ける。release = true なら、結果表示のために外したタブを元のペインに戻す */
  private teardown(s: Session, release: boolean): void {
    if (s.timer !== null) clearTimeout(s.timer);
    s.timer = null;
    const { editor, layout, store } = this.host;
    for (const id of [s.aTab, s.bTab]) if (editor.hasTab(id)) editor.setDiffMarks(id, null);
    editor.closeOverlay(s.result);
    const hidden = s.hiddenTab;
    // 結果表示のペインが空のままのときだけ戻す（利用者が別のタブを表示していたら、その操作を優先する）
    if (release && hidden && store.get(hidden) && layout.tabs[s.result] === null && layout.paneOf(hidden) < 0) {
      this.ownLayoutChange = true;
      try {
        layout.show(hidden, s.result, false);
      } finally {
        this.ownLayoutChange = false;
      }
    }
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
    if (!store.get(s.aTab) || !store.get(s.bTab)) {
      return this.fail('比較中のタブが閉じられたため、差分比較を終了しました。');
    }
    if (layout.tabs[s.a] !== s.aTab || layout.tabs[s.b] !== s.bTab || layout.tabs[s.result] !== null) {
      this.fail('比較中のペインの表示が変わったため、差分比較を終了しました。');
    }
  }

  /**
   * 比較開始前の配置に戻す。比較開始前に空だったペインは空のまま戻す。
   * 比較開始前のタブが比較中に閉じられていた場合だけ、そのペインに現在表示している
   * （他のペインに割り当てられていない）タブを補う。
   */
  private restoreLayout(prev: PaneLayoutState): void {
    const { layout, store } = this.host;
    const valid = new Set(store.all.map((t) => t.id));
    const reserved = new Set(prev.tabs.filter((id): id is string => id !== null && valid.has(id)));
    const tabs = prev.tabs.map((id, i) => {
      if (id === null || valid.has(id)) return id;
      const cur = layout.tabs[i];
      return cur && valid.has(cur) && !reserved.has(cur) ? cur : null;
    });
    this.ownLayoutChange = true;
    try {
      layout.load({ count: prev.count, tabs, active: prev.active }, valid);
    } finally {
      this.ownLayoutChange = false;
    }
  }
}
