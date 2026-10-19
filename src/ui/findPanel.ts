import { EMPTY_SEARCH, type DocMatch, type SearchOptions } from '../core/search';
import { h } from './dom';

export interface TabSearchResult {
  tabId: string;
  tabName: string;
  matches: DocMatch[];
  total: number;
  capped: boolean;
}

export interface FindPanelHost {
  onQueryChange(options: SearchOptions): void;
  findNext(): void;
  findPrevious(): void;
  selectAll(): void;
  replaceNext(): void;
  replaceAll(): void;
  searchAllTabs(): void;
  replaceAllTabs(): void;
  gotoResult(tabId: string, match: DocMatch): void;
  onClose(): void;
}

/**
 * 検索・置換パネル（エディタ上部に表示）と、全タブ横断検索の結果一覧（エディタ下部に表示）。
 */
export class FindPanel {
  readonly el: HTMLElement;
  readonly resultsEl: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly replaceRow: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly caseBtn: HTMLButtonElement;
  private readonly regexpBtn: HTMLButtonElement;
  private readonly wordBtn: HTMLButtonElement;
  private readonly toggleReplaceBtn: HTMLButtonElement;
  private readonly resultsList: HTMLElement;
  private readonly resultsHeader: HTMLElement;
  private opts: SearchOptions = { ...EMPTY_SEARCH };
  private visible = false;

  constructor(private readonly host: FindPanelHost) {
    const toggle = (label: string, title: string, key: keyof SearchOptions) => {
      const btn = h('button', {
        class: 'find-toggle',
        text: label,
        type: 'button',
        title,
        attrs: { 'aria-pressed': 'false', 'aria-label': title },
      });
      btn.addEventListener('click', () => {
        (this.opts as unknown as Record<string, boolean>)[key] = !this.opts[key];
        btn.setAttribute('aria-pressed', String(this.opts[key]));
        this.emitChange();
      });
      return btn;
    };
    const button = (text: string, title: string, onClick: () => void, cls = '') =>
      h('button', { class: `btn btn-small ${cls}`.trim(), text, type: 'button', title, on: { click: onClick } });

    this.searchInput = h('input', {
      class: 'input find-input',
      type: 'text',
      attrs: { 'aria-label': '検索する文字列', placeholder: '検索', spellcheck: 'false', autocomplete: 'off' },
    });
    this.replaceInput = h('input', {
      class: 'input find-input',
      type: 'text',
      attrs: { 'aria-label': '置換後の文字列', placeholder: '置換後', spellcheck: 'false', autocomplete: 'off' },
    });
    this.caseBtn = toggle('Aa', '大文字と小文字を区別', 'caseSensitive');
    this.wordBtn = toggle('ab|', '単語単位で検索', 'wholeWord');
    this.regexpBtn = toggle('.*', '正規表現', 'regexp');
    this.countEl = h('span', { class: 'find-count', attrs: { 'aria-live': 'polite' } });
    this.toggleReplaceBtn = h('button', {
      class: 'find-expand',
      text: '▸',
      type: 'button',
      title: '置換の表示切替 (Ctrl+H)',
      attrs: { 'aria-label': '置換の表示切替', 'aria-expanded': 'false' },
      on: { click: () => this.setReplaceVisible(this.replaceRow.hidden) },
    });

    const findRow = h('div', { class: 'find-row' }, [
      this.toggleReplaceBtn,
      this.searchInput,
      this.caseBtn,
      this.wordBtn,
      this.regexpBtn,
      this.countEl,
      button('↑', '前を検索 (Shift+Enter / Shift+F3)', () => host.findPrevious(), 'find-nav'),
      button('↓', '次を検索 (Enter / F3)', () => host.findNext(), 'find-nav'),
      button('すべて選択', '一致箇所をすべて選択（複数カーソル）', () => host.selectAll()),
      button('全タブ検索', 'すべてのタブから検索 (Ctrl+Shift+F)', () => host.searchAllTabs()),
      h('button', {
        class: 'find-close',
        text: '×',
        type: 'button',
        title: '閉じる (Esc)',
        attrs: { 'aria-label': '検索パネルを閉じる' },
        on: { click: () => this.close() },
      }),
    ]);
    this.replaceRow = h('div', { class: 'find-row find-replace-row' }, [
      h('span', { class: 'find-indent' }),
      this.replaceInput,
      button('置換', '現在の一致箇所を置換して次へ (Enter)', () => host.replaceNext()),
      button('すべて置換', 'このタブ内をすべて置換', () => host.replaceAll()),
      button('全タブで置換', 'すべてのタブで置換', () => host.replaceAllTabs()),
      h('span', {
        class: 'find-help',
        text: '正規表現時: $1 $& で参照、\\n \\t で改行・タブ',
      }),
    ]);
    this.replaceRow.hidden = true;
    this.el = h('div', { class: 'find-panel', attrs: { role: 'search', 'aria-label': '検索と置換' } }, [
      findRow,
      this.replaceRow,
    ]);
    this.el.hidden = true;

    this.searchInput.addEventListener('input', () => {
      this.opts.search = this.searchInput.value;
      this.emitChange();
    });
    this.replaceInput.addEventListener('input', () => {
      this.opts.replace = this.replaceInput.value;
      this.emitChange();
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (e.shiftKey) host.findPrevious();
        else if (e.altKey) host.selectAll();
        else host.findNext();
      }
    });
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) host.replaceAll();
        else host.replaceNext();
      }
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });

    // 横断検索の結果
    this.resultsHeader = h('span', { class: 'results-title' });
    this.resultsList = h('div', { class: 'results-list', attrs: { role: 'list' } });
    this.resultsEl = h('section', { class: 'results-panel', attrs: { 'aria-label': '全タブの検索結果' } }, [
      h('div', { class: 'results-header' }, [
        this.resultsHeader,
        h('button', {
          class: 'btn btn-small',
          text: '再検索',
          type: 'button',
          title: '現在の条件で再検索',
          on: { click: () => host.searchAllTabs() },
        }),
        h('button', {
          class: 'find-close',
          text: '×',
          type: 'button',
          title: '検索結果を閉じる',
          attrs: { 'aria-label': '検索結果を閉じる' },
          on: { click: () => this.hideResults() },
        }),
      ]),
      this.resultsList,
    ]);
    this.resultsEl.hidden = true;
    this.resultsList.addEventListener('keydown', (e) => this.onResultsKey(e));
  }

  get options(): SearchOptions {
    return { ...this.opts };
  }

  get isOpen(): boolean {
    return this.visible;
  }

  /** パネルを開いて検索欄（置換モードでは置換欄）にフォーカスする */
  open(mode: 'find' | 'replace', initialText?: string): void {
    this.visible = true;
    this.el.hidden = false;
    if (mode === 'replace') this.setReplaceVisible(true);
    if (initialText !== undefined && initialText !== '') {
      this.searchInput.value = initialText;
      this.opts.search = initialText;
    }
    this.emitChange();
    const target = mode === 'replace' && this.opts.search ? this.replaceInput : this.searchInput;
    target.focus();
    target.select();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.hidden = true;
    this.host.onClose();
  }

  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  private setReplaceVisible(show: boolean): void {
    this.replaceRow.hidden = !show;
    this.toggleReplaceBtn.textContent = show ? '▾' : '▸';
    this.toggleReplaceBtn.setAttribute('aria-expanded', String(show));
  }

  private emitChange(): void {
    this.host.onQueryChange(this.options);
  }

  setCount(text: string, kind: 'normal' | 'none' | 'error' = 'normal'): void {
    this.countEl.textContent = text;
    this.countEl.dataset.kind = kind;
    this.searchInput.setAttribute('aria-invalid', String(kind === 'error'));
  }

  /* ---------- 横断検索の結果 ---------- */

  showResults(results: TabSearchResult[], query: string): void {
    this.resultsList.replaceChildren();
    const total = results.reduce((n, r) => n + r.total, 0);
    const tabsWithHits = results.filter((r) => r.total > 0);
    const capped = results.some((r) => r.capped);
    this.resultsHeader.textContent = total
      ? `「${query}」の検索結果: ${total.toLocaleString()} 件${capped ? '以上' : ''}（${tabsWithHits.length} タブ）`
      : `「${query}」は見つかりませんでした`;
    for (const r of tabsWithHits) {
      const group = h('div', { class: 'results-group', attrs: { role: 'listitem' } });
      group.append(
        h('div', {
          class: 'results-tab',
          text: `${r.tabName}（${r.total.toLocaleString()} 件${r.capped ? '以上' : ''}${r.matches.length < r.total ? `、先頭 ${r.matches.length} 件を表示` : ''}）`,
        }),
      );
      for (const m of r.matches) {
        const preview = h('span', { class: 'result-text' }, [
          m.preview.slice(0, m.previewFrom),
          h('mark', { text: m.preview.slice(m.previewFrom, Math.max(m.previewFrom, m.previewTo)) }),
          m.preview.slice(Math.max(m.previewFrom, m.previewTo)),
        ]);
        const item = h(
          'button',
          {
            class: 'result-item',
            type: 'button',
            title: `${r.tabName} の ${m.line} 行目へ移動`,
          },
          [h('span', { class: 'result-line', text: `${m.line}:` }), preview],
        );
        item.addEventListener('click', () => this.host.gotoResult(r.tabId, m));
        group.append(item);
      }
      this.resultsList.append(group);
    }
    this.resultsEl.hidden = false;
    const first = this.resultsList.querySelector<HTMLElement>('.result-item');
    if (!first) this.resultsList.append(h('div', { class: 'results-empty', text: '一致する箇所はありません。' }));
  }

  hideResults(): void {
    this.resultsEl.hidden = true;
  }

  focusResults(): void {
    this.resultsList.querySelector<HTMLElement>('.result-item')?.focus();
  }

  private onResultsKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(this.resultsList.querySelectorAll<HTMLElement>('.result-item'));
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next = items[e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0)];
    next?.focus();
    e.preventDefault();
  }
}
