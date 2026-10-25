import {
  findNext,
  findPrevious,
  replaceNext,
  selectMatches,
  type SearchQuery,
} from '@codemirror/search';
import {
  buildReplaceAll,
  buildReplacePreview,
  getReplacementExamples,
  countMatches,
  createQuery,
  EMPTY_SEARCH,
  findInDocument,
  iterateMatches,
  regexpError,
  type DocMatch,
  type SearchOptions,
} from '../core/search';
import { showReplacePreview } from '../ui/replacePreview';
import type { FindPanelHost, TabSearchResult } from '../ui/findPanel';
import type { App } from './app';

/**
 * 検索・置換の制御。
 * 現在のタブでは CodeMirror の検索コマンドを利用し、全タブ横断検索・置換は各タブの EditorState に対して行う。
 */
export class SearchController implements FindPanelHost {
  private options: SearchOptions = { ...EMPTY_SEARCH };
  private query: SearchQuery = createQuery(EMPTY_SEARCH);
  private replacementRevision = 0;
  private replacementPreviewOpen = false;
  private countTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly app: App) {}

  private get view() {
    return this.app.editor.view;
  }

  private get panelOpen(): boolean {
    return this.app.findPanel.isOpen;
  }

  /** 検索パネルを開く（選択中の文字列を検索語にする） */
  open(mode: 'find' | 'replace'): void {
    const state = this.view.state;
    const sel = state.selection.main;
    let initial: string | undefined;
    if (!sel.empty && sel.to - sel.from <= 200) {
      const text = state.sliceDoc(sel.from, sel.to);
      if (!text.includes('\n')) initial = text;
    }
    if (initial !== undefined && this.options.regexp) initial = escapeRegExp(initial);
    this.app.findPanel.open(mode, initial);
  }

  openAndSearchAll(): void {
    if (!this.panelOpen) this.open('find');
    if (this.options.search) this.searchAllTabs();
    else this.app.findPanel.focusSearch();
  }

  /* ---------- FindPanelHost ---------- */

  onQueryChange(options: SearchOptions): void {
    const textChanged = options.search !== this.options.search;
    const changed =
      textChanged ||
      options.caseSensitive !== this.options.caseSensitive ||
      options.regexp !== this.options.regexp ||
      options.wholeWord !== this.options.wholeWord;
    if (changed) this.invalidateResults();
    if (options.replace !== this.options.replace) this.replacementRevision++;
    this.options = options;
    this.query = createQuery(options);
    this.app.editor.setSearch(this.query, true);
    // 入力に合わせてカーソル位置以降の最初の一致箇所を選択する
    if (changed && this.query.valid && this.app.store.activeTabId) this.selectNearest();
    this.updateCount(true);
  }

  private selectNearest(): void {
    const state = this.view.state;
    const start = state.selection.main.from;
    let target: { from: number; to: number } | null = null;
    for (const m of iterateMatches(this.query, state)) {
      if (m.from >= start) {
        target = m;
        break;
      }
      target ??= m;
    }
    const id = this.app.store.activeTabId;
    if (target && id) this.app.editor.select(id, target.from, target.to);
  }

  findNext(): void {
    this.runFind(findNext);
  }

  findPrevious(): void {
    this.runFind(findPrevious);
  }

  /** 検索・置換の対象（アクティブなペインのタブ）があるか。なければ利用者に知らせる */
  private hasTarget(): boolean {
    if (this.app.store.activeTabId) return true;
    this.app.notifications.toast('アクティブなペインにタブが表示されていません。');
    return false;
  }

  private runFind(cmd: typeof findNext): void {
    if (!this.hasTarget()) return;
    if (!this.query.valid) {
      if (!this.panelOpen) this.open('find');
      else this.app.findPanel.focusSearch();
      return;
    }
    this.app.editor.setSearch(this.query, this.panelOpen);
    if (!cmd(this.view)) this.app.notifications.toast('見つかりませんでした。');
    this.updateCount(true);
  }

  selectAll(): void {
    if (!this.query.valid || !this.hasTarget()) return;
    if (selectMatches(this.view)) this.app.editor.focus();
    else this.app.notifications.toast('見つかりませんでした。');
  }

  replaceNext(): void {
    if (!this.query.valid || !this.hasTarget()) return;
    if (!replaceNext(this.view)) this.app.notifications.toast('見つかりませんでした。');
    this.updateCount(true);
  }

  replaceAll(): void {
    if (!this.query.valid || !this.hasTarget()) return;
    const { changes, count } = buildReplaceAll(this.query, this.view.state);
    if (!count) {
      this.app.notifications.toast('一致する箇所はありません。');
      return;
    }
    this.view.dispatch({ changes, userEvent: 'input.replace.all' });
    this.app.notifications.toast(`${count.toLocaleString()} 件を置換しました（Ctrl+Z で元に戻せます）。`, 'success');
    this.updateCount(true);
  }

  /** すべてのタブから検索して結果一覧を表示する */
  searchAllTabs(): void {
    if (!this.query.valid) {
      this.app.findPanel.focusSearch();
      return;
    }
    const results: TabSearchResult[] = [];
    for (const tab of this.app.store.all) {
      const source = this.app.editor.getSearchSource(tab.id);
      if (source === null) continue;
      const r = findInDocument(this.query, source, 500);
      results.push({ tabId: tab.id, tabName: tab.name, ...r });
    }
    this.app.findPanel.showResults(results, this.options.search);
  }

  async replaceAllTabs(): Promise<void> {
    if (!this.query.valid || this.replacementPreviewOpen) return;
    this.replacementPreviewOpen = true;
    try {
      const query = this.query;
      const revision = this.replacementRevision;
      const plans = [];
      for (const [index, tab] of this.app.store.all.entries()) {
        const source = this.app.editor.getSearchSource(tab.id);
        if (source === null) continue;
        const plan = buildReplacePreview(query, source, 0);
        if (plan.count) {
          plans.push({ ...plan, source, id: tab.id, name: tab.name, tabNumber: index + 1 });
        }
      }
      if (!plans.length) {
        this.app.notifications.toast('どのタブにも一致する箇所はありません。');
        return;
      }
      const staleMessage = 'プレビュー後に本文・検索条件・タブ構成が変更されました。キャンセルしてプレビューを作り直してください。';
      const byId = new Map(plans.map(plan => [plan.id, plan]));
      const selectedIds = await showReplacePreview(plans,
        id => getReplacementExamples(query, byId.get(id)!.source),
        () => revision === this.replacementRevision ? null : staleMessage);
      if (!selectedIds?.length) return;
      // モーダルの終了からこの継続処理までに発生した変更も検知する。
      if (revision !== this.replacementRevision) {
        this.app.notifications.toast(staleMessage, 'warning');
        return;
      }
      const selected = new Set(selectedIds);
      const selectedPlans = plans.filter(plan => selected.has(plan.id));
      const selectedTotal = selectedPlans.reduce((sum, plan) => sum + plan.count, 0);
      for (const plan of selectedPlans) {
        this.app.editor.applyToTab(plan.id, (state) => {
          const { changes, count } = buildReplaceAll(query, state);
          return count ? { changes, userEvent: 'input.replace.all' } : null;
        });
      }
      this.app.notifications.toast(`${selectedPlans.length} 個のタブで ${selectedTotal.toLocaleString()} 件を置換しました。`, 'success');
      this.updateCount(true);
      if (!this.app.findPanel.resultsEl.hidden) this.searchAllTabs();
    } finally {
      this.replacementPreviewOpen = false;
    }
  }

  gotoResult(tabId: string, match: DocMatch): void {
    if (this.app.findPanel.resultsStale) {
      this.app.notifications.toast('検索結果が古くなっています。「再検索」で更新してください。', 'warning');
      return;
    }
    if (!this.app.store.get(tabId)) {
      this.app.notifications.toast('このタブは既に閉じられています。', 'warning');
      return;
    }
    this.app.activateTab(tabId);
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(match.line, doc.lines));
    const from = Math.min(line.from + match.column - 1, line.to);
    const to = Math.min(from + (match.to - match.from), doc.length);
    this.app.editor.select(tabId, from, to);
    this.app.editor.focus();
  }

  onClose(): void {
    this.app.editor.setSearch(this.query, false);
    this.app.editor.focus();
  }

  /* ---------- 状態変化への追従 ---------- */

  invalidateResults(): void {
    this.replacementRevision++;
    this.app.findPanel.markResultsStale();
  }

  onActiveTabChanged(): void {
    this.updateCount(true);
  }

  onDocChanged(): void {
    this.updateCount(false);
  }

  onSelectionChanged(): void {
    this.updateCount(false);
  }

  /** 一致件数の表示を更新する（大きな文書では入力中の負荷を避けるため遅延させる） */
  private updateCount(immediate: boolean): void {
    if (!this.panelOpen) return;
    if (this.countTimer) clearTimeout(this.countTimer);
    const run = () => {
      this.countTimer = null;
      this.renderCount();
    };
    if (immediate) run();
    else this.countTimer = setTimeout(run, this.view.state.doc.length > 200_000 ? 300 : 60);
  }

  private renderCount(): void {
    const panel = this.app.findPanel;
    if (!this.options.search) {
      panel.setCount('');
      return;
    }
    const err = regexpError(this.options);
    if (err) {
      panel.setCount('正規表現が不正です', 'error');
      return;
    }
    const { total, capped, current } = countMatches(this.query, this.view.state);
    if (!total) {
      panel.setCount('0 件', 'none');
      return;
    }
    const totalText = `${total.toLocaleString()}${capped ? '+' : ''} 件`;
    panel.setCount(current ? `${current.toLocaleString()} / ${totalText}` : totalText);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
