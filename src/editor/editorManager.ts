import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language';
import {
  highlightSelectionMatches,
  search,
  selectNextOccurrence,
  selectSelectionMatches,
  setSearchQuery,
  type SearchQuery,
} from '@codemirror/search';
import {
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  type Extension,
  type StateEffect,
  type Text,
  type TransactionSpec,
} from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import type { EditorMode, LineEnding, SelectionJSON, Settings } from '../core/types';
import { getLoadedLanguage, loadLanguage } from './languages';
import { themeExtension } from './theme';
import {
  eolFacet,
  searchActiveField,
  searchHighlighter,
  setSearchActive,
  showLineEndings,
} from './visualize';

/** 各 EditorState がどのタブのものかを示す */
const tabIdFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? '' });

/** CodeMirror 内部の英語表示を日本語化する */
const phrases = EditorState.phrases.of({
  'Fold line': '折りたたむ',
  'Unfold line': '展開する',
  'Folded lines': '折りたたまれた行',
  'Unfolded lines': '展開された行',
  'folded code': '折りたたまれたコード',
  unfold: '展開',
  'Control character': '制御文字',
  'Selection deleted': '選択範囲を削除しました',
  'replaced match on line $': '$ 行目の一致箇所を置換しました',
  'replaced $ matches': '$ 件を置換しました',
  'current match': '現在の一致箇所',
  'on line': '行',
});

const editorKeymap = [
  ...defaultKeymap,
  ...historyKeymap,
  ...foldKeymap,
  indentWithTab,
  { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
  { key: 'Mod-Shift-l', run: selectSelectionMatches, preventDefault: true },
];

export interface RestoreInfo {
  selection?: SelectionJSON;
  /** 画面上端に表示する文書内位置 */
  scrollPos?: number;
}

interface Entry {
  id: string;
  mode: EditorMode;
  eol: LineEnding;
  /** 未作成の場合の本文（初回表示時に EditorState を作る） */
  content: string | null;
  state: EditorState | null;
  restore: RestoreInfo | null;
  scrollSnapshot: { effect: StateEffect<unknown>; doc: Text } | null;
  scrollPos: number;
  configGeneration: number;
}

export interface EditorCallbacks {
  /** 本文が変更された（アクティブ・非アクティブを問わない） */
  onDocChange(tabId: string): void;
  /** アクティブタブのカーソル・選択範囲・本文が変化した */
  onCursorActivity(tabId: string): void;
  /** アクティブタブのスクロール位置が変化した */
  onScroll?(tabId: string): void;
}

/**
 * CodeMirror の EditorView を 1 つだけ持ち、タブごとの EditorState を切り替えて表示する。
 * EditorState に Undo/Redo 履歴・選択範囲が含まれるため、タブを切り替えても履歴は維持される。
 */
export class EditorManager {
  readonly view: EditorView;
  private entries = new Map<string, Entry>();
  private activeId: string | null = null;
  private settings: Settings;
  private configGeneration = 0;
  private searchQuery: SearchQuery | null = null;
  private searchActive = false;
  private readonly emptyState: EditorState;

  private readonly language = new Compartment();
  private readonly eol = new Compartment();
  private readonly theme = new Compartment();
  private readonly wrap = new Compartment();
  private readonly gutter = new Compartment();
  private readonly indent = new Compartment();
  private readonly whitespace = new Compartment();
  private readonly eolMarkers = new Compartment();

  constructor(
    parent: HTMLElement,
    settings: Settings,
    private readonly callbacks: EditorCallbacks,
  ) {
    this.settings = settings;
    this.emptyState = EditorState.create({
      doc: '',
      extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), themeExtension(settings.theme)],
    });
    this.view = new EditorView({ state: this.emptyState, parent });
    this.view.scrollDOM.addEventListener(
      'scroll',
      () => {
        if (this.activeId) this.callbacks.onScroll?.(this.activeId);
      },
      { passive: true },
    );
  }

  get activeTabId(): string | null {
    return this.activeId;
  }

  /* ---------- 拡張の構成 ---------- */

  private globalConfig(): Record<string, Extension> {
    const s = this.settings;
    return {
      theme: themeExtension(s.theme),
      wrap: s.wordWrap ? EditorView.lineWrapping : [],
      gutter: s.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
      indent: [
        EditorState.tabSize.of(s.tabSize),
        indentUnit.of(s.indentWithTabs ? '\t' : ' '.repeat(s.tabSize)),
      ],
      whitespace: s.showWhitespace ? highlightWhitespace() : [],
      eolMarkers: s.showLineEndings ? showLineEndings : [],
    };
  }

  private createState(entry: Entry, doc: string): EditorState {
    const g = this.globalConfig();
    const extensions: Extension[] = [
      tabIdFacet.of(entry.id),
      phrases,
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      crosshairCursor(),
      highlightSpecialChars(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      foldGutter(),
      search(),
      searchActiveField,
      searchHighlighter,
      keymap.of(editorKeymap),
      EditorView.contentAttributes.of({ 'aria-label': 'テキスト編集領域', spellcheck: 'false' }),
      EditorView.domEventHandlers({
        // ファイルのドロップはアプリ側でタブとして開く（本文への挿入はしない）
        drop: (e) => !!e.dataTransfer?.files.length,
      }),
      EditorView.updateListener.of((u) => {
        const id = u.state.facet(tabIdFacet);
        if (u.docChanged) this.callbacks.onDocChange(id);
        if (u.docChanged || u.selectionSet) this.callbacks.onCursorActivity(id);
      }),
      this.language.of(getLoadedLanguage(entry.mode) ?? []),
      this.eol.of(eolFacet.of(entry.eol)),
      this.theme.of(g.theme),
      this.wrap.of(g.wrap),
      this.gutter.of(g.gutter),
      this.indent.of(g.indent),
      this.whitespace.of(g.whitespace),
      this.eolMarkers.of(g.eolMarkers),
    ];
    let selection: EditorSelection | undefined;
    const sel = entry.restore?.selection;
    if (sel) {
      const len = doc.length;
      const ranges = sel.ranges.map((r) =>
        EditorSelection.range(Math.min(r.anchor, len), Math.min(r.head, len)),
      );
      selection = EditorSelection.create(ranges, Math.min(sel.main, ranges.length - 1));
    }
    entry.configGeneration = this.configGeneration;
    return EditorState.create({ doc, selection, extensions });
  }

  private reconfigureEffects(entry: Entry): StateEffect<unknown>[] {
    const g = this.globalConfig();
    return [
      this.theme.reconfigure(g.theme),
      this.wrap.reconfigure(g.wrap),
      this.gutter.reconfigure(g.gutter),
      this.indent.reconfigure(g.indent),
      this.whitespace.reconfigure(g.whitespace),
      this.eolMarkers.reconfigure(g.eolMarkers),
      this.language.reconfigure(getLoadedLanguage(entry.mode) ?? []),
      this.eol.reconfigure(eolFacet.of(entry.eol)),
    ];
  }

  /** エントリの EditorState を取得する（未作成なら作成） */
  private ensureState(entry: Entry): EditorState {
    if (!entry.state) {
      entry.state = this.createState(entry, entry.content ?? '');
      entry.content = null;
    }
    return entry.state;
  }

  /** 現在の状態（アクティブタブは view の状態） */
  private currentState(entry: Entry): EditorState {
    if (entry.id === this.activeId) return this.view.state;
    return this.ensureState(entry);
  }

  /* ---------- タブの追加・削除・切り替え ---------- */

  addTab(id: string, mode: EditorMode, eol: LineEnding, content: string, restore?: RestoreInfo): void {
    const entry: Entry = {
      id,
      mode,
      eol,
      content,
      state: null,
      restore: restore ?? null,
      scrollSnapshot: null,
      scrollPos: restore?.scrollPos ?? 0,
      configGeneration: -1,
    };
    this.entries.set(id, entry);
    if (!getLoadedLanguage(mode)) void this.ensureLanguage(id, mode);
  }

  hasTab(id: string): boolean {
    return this.entries.has(id);
  }

  removeTab(id: string): void {
    if (this.activeId === id) {
      this.activeId = null;
      this.view.setState(this.emptyState);
    }
    this.entries.delete(id);
  }

  /** 全タブを破棄する（バックアップからの復元時など） */
  clear(): void {
    this.activeId = null;
    this.view.setState(this.emptyState);
    this.entries.clear();
  }

  /** 表示するタブを切り替える */
  activate(id: string | null): void {
    if (id === this.activeId) return;
    this.saveActiveViewState();
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry) {
      this.activeId = null;
      this.view.setState(this.emptyState);
      return;
    }
    const state = this.ensureState(entry);
    this.activeId = entry.id;
    this.view.setState(state);
    const effects: StateEffect<unknown>[] = [];
    if (entry.configGeneration !== this.configGeneration) {
      effects.push(...this.reconfigureEffects(entry));
      entry.configGeneration = this.configGeneration;
    }
    effects.push(...this.searchEffects(this.view.state));
    // スクロール位置の復元
    if (entry.scrollSnapshot && entry.scrollSnapshot.doc === state.doc) {
      effects.push(entry.scrollSnapshot.effect);
    } else if (entry.scrollPos > 0) {
      const pos = Math.min(entry.scrollPos, state.doc.length);
      effects.push(EditorView.scrollIntoView(pos, { y: 'start' }));
    } else if (entry.restore?.selection) {
      effects.push(EditorView.scrollIntoView(state.selection.main.head, { y: 'center' }));
    }
    entry.restore = null;
    if (effects.length) this.view.dispatch({ effects });
  }

  /** アクティブタブの表示状態（EditorState・スクロール位置）を退避する */
  private saveActiveViewState(): void {
    if (!this.activeId) return;
    const entry = this.entries.get(this.activeId);
    if (!entry) return;
    entry.state = this.view.state;
    entry.scrollSnapshot = { effect: this.view.scrollSnapshot(), doc: this.view.state.doc };
    entry.scrollPos = this.topVisiblePos();
  }

  private topVisiblePos(): number {
    const view = this.view;
    if (view.state.doc.length === 0) return 0;
    try {
      const top = view.scrollDOM.scrollTop;
      if (top <= 0) return 0;
      return view.lineBlockAtHeight(top).from;
    } catch {
      return 0;
    }
  }

  /* ---------- 本文・状態の取得 ---------- */

  getContent(id: string): string {
    const entry = this.entries.get(id);
    if (!entry) return '';
    if (entry.id === this.activeId) return this.view.state.doc.toString();
    if (entry.state) return entry.state.doc.toString();
    return entry.content ?? '';
  }

  /** 検索などのために EditorState を取得する（未作成なら作成） */
  getState(id: string): EditorState | null {
    const entry = this.entries.get(id);
    return entry ? this.currentState(entry) : null;
  }

  /**
   * 検索用の文書。未表示のタブは EditorState を作らずに本文文字列を返す
   * （構文解析などの負荷を避けるため）。
   */
  getSearchSource(id: string): EditorState | string | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.id === this.activeId) return this.view.state;
    return entry.state ?? entry.content ?? '';
  }

  /** 本文の長さ（EditorState を作らずに取得） */
  getLength(id: string): number {
    const entry = this.entries.get(id);
    if (!entry) return 0;
    if (entry.id === this.activeId) return this.view.state.doc.length;
    if (entry.state) return entry.state.doc.length;
    return entry.content?.length ?? 0;
  }

  getSelection(id: string): SelectionJSON | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.id === this.activeId) return this.view.state.selection.toJSON() as SelectionJSON;
    if (entry.state) return entry.state.selection.toJSON() as SelectionJSON;
    return entry.restore?.selection;
  }

  getScrollPos(id: string): number {
    const entry = this.entries.get(id);
    if (!entry) return 0;
    if (entry.id === this.activeId) return this.topVisiblePos();
    return entry.scrollPos;
  }

  /**
   * タブに変更を適用する（非アクティブタブにも適用可能）。
   * 変更は各タブの Undo 履歴に記録される。
   */
  applyToTab(id: string, build: (state: EditorState) => TransactionSpec | null): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const spec = build(this.currentState(entry));
    if (!spec) return false;
    if (entry.id === this.activeId) {
      this.view.dispatch(spec);
    } else {
      const tr = this.ensureState(entry).update(spec);
      entry.state = tr.state;
      if (tr.docChanged) this.callbacks.onDocChange(id);
    }
    return true;
  }

  /* ---------- モード・改行コード ---------- */

  private async ensureLanguage(id: string, mode: EditorMode): Promise<void> {
    await loadLanguage(mode);
    const entry = this.entries.get(id);
    if (!entry || entry.mode !== mode) return;
    this.reconfigureEntry(entry, [this.language.reconfigure(getLoadedLanguage(mode) ?? [])]);
  }

  private reconfigureEntry(entry: Entry, effects: StateEffect<unknown>[]): void {
    if (entry.id === this.activeId) {
      this.view.dispatch({ effects });
    } else if (entry.state) {
      entry.state = entry.state.update({ effects }).state;
    }
  }

  setMode(id: string, mode: EditorMode): void {
    const entry = this.entries.get(id);
    if (!entry || entry.mode === mode) return;
    entry.mode = mode;
    const ext = getLoadedLanguage(mode);
    if (ext) this.reconfigureEntry(entry, [this.language.reconfigure(ext)]);
    else void this.ensureLanguage(id, mode);
  }

  setEol(id: string, eol: LineEnding): void {
    const entry = this.entries.get(id);
    if (!entry || entry.eol === eol) return;
    entry.eol = eol;
    this.reconfigureEntry(entry, [this.eol.reconfigure(eolFacet.of(eol))]);
  }

  /* ---------- 設定 ---------- */

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.configGeneration++;
    const entry = this.activeId ? this.entries.get(this.activeId) : undefined;
    if (entry) {
      this.view.dispatch({ effects: this.reconfigureEffects(entry) });
      entry.configGeneration = this.configGeneration;
    } else {
      this.view.setState(
        EditorState.create({
          doc: '',
          extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), themeExtension(settings.theme)],
        }),
      );
    }
    this.view.requestMeasure();
  }

  /* ---------- 検索 ---------- */

  private searchEffects(state: EditorState): StateEffect<unknown>[] {
    const effects: StateEffect<unknown>[] = [];
    if (this.searchQuery) effects.push(setSearchQuery.of(this.searchQuery));
    if (state.field(searchActiveField, false) !== this.searchActive) {
      effects.push(setSearchActive.of(this.searchActive));
    }
    return effects;
  }

  /** 検索条件をアクティブタブに反映する（タブ切り替え時にも引き継ぐ） */
  setSearch(query: SearchQuery | null, active: boolean): void {
    this.searchQuery = query;
    this.searchActive = active;
    if (this.activeId) this.view.dispatch({ effects: this.searchEffects(this.view.state) });
  }

  focus(): void {
    this.view.focus();
  }

  /** 指定位置を選択してスクロールする */
  select(id: string, anchor: number, head = anchor): void {
    if (id !== this.activeId) return;
    const len = this.view.state.doc.length;
    const range = EditorSelection.range(Math.min(anchor, len), Math.min(head, len));
    this.view.dispatch({
      selection: EditorSelection.create([range]),
      effects: EditorView.scrollIntoView(range, { y: 'center' }),
      userEvent: 'select',
    });
  }
}
