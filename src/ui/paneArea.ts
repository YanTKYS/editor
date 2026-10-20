import { MAX_PANES, type PaneLayout } from '../core/paneLayout';
import type { TabStore } from '../core/tabStore';
import { h } from './dom';

/** タブバーからドラッグ中のタブ ID を運ぶデータ形式 */
export const TAB_DRAG_TYPE = 'application/x-editor-tab';

export interface PaneAreaActions {
  /** ペインをクリック・フォーカスした */
  activatePane(index: number): void;
  /** タブがペインへドロップされた */
  dropTab(tabId: string, index: number): void;
  /** ペインに表示するタブを選ぶ（anchor: メニューの表示位置） */
  pickTab(index: number, anchor: HTMLElement): void;
}

interface PaneElements {
  root: HTMLElement;
  header: HTMLElement;
  title: HTMLElement;
  badge: HTMLElement;
  host: HTMLElement;
  empty: HTMLElement;
  /** 表示するタブがあるか */
  hasTab: boolean;
}

/** 差分比較中の各ペインの役割（ペイン番号は 0 始まり） */
export interface DiffRoles {
  a: number;
  b: number;
  result: number;
}

/**
 * 編集ペインの並び（左右に等幅で並べる）。
 * 各ペインは見出し（分割時のみ）・エディタ・空のペインの案内からなる。
 * ペインの中身（EditorView）は EditorManager が host 要素に作成する。
 */
export class PaneArea {
  readonly el: HTMLElement;
  private readonly panes: PaneElements[] = [];
  private roles: DiffRoles | null = null;

  constructor(private readonly actions: PaneAreaActions) {
    this.el = h('div', {
      class: 'pane-grid',
      attrs: { id: 'editor-area', role: 'tabpanel', 'aria-label': '編集領域' },
    });
    for (let i = 0; i < MAX_PANES; i++) this.panes.push(this.createPane(i));
  }

  /** ペイン i のエディタ表示先 */
  host(index: number): HTMLElement {
    return this.panes[index].host;
  }

  private createPane(index: number): PaneElements {
    const title = h('span', { class: 'pane-title' });
    const pick = h('button', {
      class: 'pane-pick',
      text: '▾',
      type: 'button',
      title: 'このペインに表示するタブを選ぶ',
      attrs: { 'aria-label': `ペイン ${index + 1} に表示するタブを選ぶ`, 'aria-haspopup': 'menu' },
    });
    pick.addEventListener('click', () => this.actions.pickTab(index, pick));
    const badge = h('span', { class: 'pane-diff-badge' });
    badge.hidden = true;
    const header = h('div', { class: 'pane-header' }, [
      h('span', { class: 'pane-number', text: String(index + 1) }),
      title,
      badge,
      pick,
    ]);
    const host = h('div', { class: 'editor-host' });
    const chooser = h('button', { class: 'btn btn-small', text: 'タブを選択…', type: 'button' });
    chooser.addEventListener('click', () => this.actions.pickTab(index, chooser));
    const empty = h('div', { class: 'pane-empty' }, [
      h('p', { text: 'このペインにはタブが表示されていません。' }),
      h('p', { text: 'タブバーのタブをクリックするか、ここへドラッグしてください。' }),
      chooser,
    ]);
    const root = h(
      'section',
      { class: 'pane', dataset: { pane: String(index) }, attrs: { 'aria-label': `ペイン ${index + 1}` } },
      [header, h('div', { class: 'pane-body' }, [host, empty])],
    );

    // クリック・キーボードでのフォーカスでアクティブにする（CodeMirror より先に処理する）
    root.addEventListener('pointerdown', () => this.actions.activatePane(index), true);
    root.addEventListener('focusin', () => this.actions.activatePane(index));

    // タブのドロップ（エディタ本文への挿入をさせないため、捕捉フェーズで処理する）
    const isTabDrag = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(TAB_DRAG_TYPE);
    root.addEventListener(
      'dragover',
      (e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        root.classList.add('drop-target');
      },
      true,
    );
    root.addEventListener('dragleave', (e) => {
      if (!root.contains(e.relatedTarget as Node)) root.classList.remove('drop-target');
    });
    root.addEventListener(
      'drop',
      (e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        root.classList.remove('drop-target');
        const id = e.dataTransfer?.getData(TAB_DRAG_TYPE);
        if (id) this.actions.dropTab(id, index);
      },
      true,
    );
    this.el.append(root);
    return { root, header, title, badge, host, empty, hasTab: false };
  }

  /**
   * 差分比較中のペインに「比較元」「比較先」「差分結果」の表示を付ける（比較中でなければ null）。
   * 結果表示のペインは、タブがなくてもエディタ（差分結果）を表示する。
   */
  setDiffRoles(roles: DiffRoles | null): void {
    this.roles = roles;
    this.panes.forEach((p, i) => {
      const role = roles?.a === i ? 'a' : roles?.b === i ? 'b' : roles?.result === i ? 'result' : null;
      p.badge.hidden = !role;
      p.badge.textContent = role === 'a' ? '比較元' : role === 'b' ? '比較先' : role === 'result' ? '差分結果' : '';
      if (role) p.root.dataset.diff = role;
      else delete p.root.dataset.diff;
      this.applyVisibility(p, i);
    });
  }

  private applyVisibility(p: PaneElements, index: number): void {
    const result = this.roles?.result === index;
    p.empty.hidden = p.hasTab || result;
    p.host.hidden = !p.hasTab && !result;
    p.root.classList.toggle('empty', !p.hasTab && !result);
    if (result) {
      p.title.textContent = '差分結果（読み取り専用）';
      p.title.title = '';
    }
  }

  /** 配置を画面に反映する */
  render(layout: PaneLayout, store: TabStore): void {
    const count = layout.count;
    this.el.dataset.count = String(count);
    this.el.style.setProperty('--pane-count', String(count));
    this.panes.forEach((p, i) => {
      const visible = i < count;
      p.root.hidden = !visible;
      if (!visible) {
        p.root.classList.remove('drop-target');
        return;
      }
      const tab = layout.tabs[i] ? store.get(layout.tabs[i]!) : null;
      const active = i === layout.active;
      p.root.classList.toggle('active', active);
      p.header.hidden = count === 1;
      p.title.textContent = tab ? `${tab.modifiedSinceFile ? '● ' : ''}${tab.name}` : '（空）';
      p.title.title = tab ? tab.name : '';
      p.hasTab = !!tab;
      this.applyVisibility(p, i);
    });
  }
}
