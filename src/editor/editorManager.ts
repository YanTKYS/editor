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
  Decoration,
  type DecorationSet,
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
import { diffExtension, diffMarksField, diffMarksSpec } from './diffMarks';
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
  /** 本文が変更された（表示中・非表示を問わない） */
  onDocChange(tabId: string): void;
  /** 表示中のタブのカーソル・選択範囲・本文が変化した */
  onCursorActivity(tabId: string): void;
  /** 表示中のタブのスクロール位置が変化した */
  onScroll?(tabId: string): void;
}

interface Pane {
  view: EditorView;
  tabId: string | null;
}

/**
 * ペインごとに CodeMirror の EditorView を持ち、タブごとの EditorState を切り替えて表示する。
 * EditorState に Undo/Redo 履歴・選択範囲が含まれるため、タブの表示先（ペイン）や
 * 表示・非表示が変わっても履歴は維持される。各タブは高々 1 つのペインに表示する。
 */
export class EditorManager {
  private entries = new Map<string, Entry>();
  private panes: Pane[] = [];
  private activePane = 0;
  private settings: Settings;
  private configGeneration = 0;
  private searchQuery: SearchQuery | null = null;
  private searchActive = false;

  private readonly language = new Compartment();
  private readonly eol = new Compartment();
  private readonly theme = new Compartment();
  private readonly wrap = new Compartment();
  private readonly gutter = new Compartment();
  private readonly indent = new Compartment();
  private readonly whitespace = new Compartment();
  private readonly eolMarkers = new Compartment();

  constructor(
    settings: Settings,
    private readonly callbacks: EditorCallbacks,
  ) {
    this.settings = settings;
  }

  /** ペインの表示先要素を登録する（EditorView を作成する） */
  attachPane(index: number, host: HTMLElement): void {
    if (this.panes[index]) return;
    const view = new EditorView({ state: this.emptyState(), parent: host });
    const pane: Pane = { view, tabId: null };
    view.scrollDOM.addEventListener(
      'scroll',
      () => {
        if (pane.tabId) this.callbacks.onScroll?.(pane.tabId);
      },
      { passive: true },
    );
    this.panes[index] = pane;
  }

  private emptyState(): EditorState {
    return EditorState.create({
      doc: '',
      extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), themeExtension(this.settings.theme)],
    });
  }

  /** アクティブなペインの EditorView（ペインが空なら読み取り専用の空の状態） */
  get view(): EditorView {
    return this.panes[this.activePane].view;
  }

  /** アクティブなペインに表示しているタブ */
  get activeTabId(): string | null {
    return this.panes[this.activePane]?.tabId ?? null;
  }

  get activePaneIndex(): number {
    return this.activePane;
  }

  /** タブを表示しているペインの番号（表示していなければ -1） */
  paneOfTab(id: string): number {
    return this.panes.findIndex((p) => p?.tabId === id);
  }

  /** タブを表示している EditorView */
  private liveView(id: string): EditorView | null {
    const i = this.paneOfTab(id);
    return i >= 0 ? this.panes[i].view : null;
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
      diffExtension,
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

  /** 現在の状態（表示中のタブは EditorView の状態） */
  private currentState(entry: Entry): EditorState {
    return this.liveView(entry.id)?.state ?? this.ensureState(entry);
  }

  /* ---------- タブの追加・削除 ---------- */

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
    const i = this.paneOfTab(id);
    if (i >= 0) {
      this.panes[i].tabId = null;
      this.panes[i].view.setState(this.emptyState());
    }
    this.entries.delete(id);
  }

  /** 全タブを破棄する（バックアップからの復元時など） */
  clear(): void {
    for (const pane of this.panes) {
      if (!pane) continue;
      pane.tabId = null;
      pane.view.setState(this.emptyState());
    }
    this.entries.clear();
  }

  /* ---------- ペインへの表示 ---------- */

  /**
   * ペインに表示するタブを切り替える（null で空のペインにする）。
   * 他のペインに表示中のタブは、そちらから外してから表示する。
   */
  showInPane(index: number, id: string | null): void {
    const pane = this.panes[index];
    if (!pane || pane.tabId === id) return;
    this.detach(pane);
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry) {
      pane.view.setState(this.emptyState());
      return;
    }
    const other = this.paneOfTab(entry.id);
    if (other >= 0) {
      this.detach(this.panes[other]);
      this.panes[other].view.setState(this.emptyState());
    }
    const state = this.ensureState(entry);
    pane.tabId = entry.id;
    pane.view.setState(state);
    const effects: StateEffect<unknown>[] = [];
    if (entry.configGeneration !== this.configGeneration) {
      effects.push(...this.reconfigureEffects(entry));
      entry.configGeneration = this.configGeneration;
    }
    effects.push(...this.searchEffects(pane.view.state, index === this.activePane));
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
    if (effects.length) pane.view.dispatch({ effects });
  }

  /** ペインに表示中のタブの状態（EditorState・スクロール位置）を退避し、ペインから外す */
  private detach(pane: Pane): void {
    if (!pane.tabId) return;
    const entry = this.entries.get(pane.tabId);
    if (entry) {
      entry.state = pane.view.state;
      entry.scrollSnapshot = { effect: pane.view.scrollSnapshot(), doc: pane.view.state.doc };
      entry.scrollPos = topVisiblePos(pane.view);
    }
    pane.tabId = null;
  }

  /** アクティブなペインを切り替える（検索の強調表示はアクティブなペインだけに出す） */
  setActivePane(index: number): void {
    if (!this.panes[index] || index === this.activePane) return;
    const prev = this.panes[this.activePane];
    this.activePane = index;
    if (prev?.tabId) prev.view.dispatch({ effects: this.searchEffects(prev.view.state, false) });
    const next = this.panes[index];
    if (next.tabId) next.view.dispatch({ effects: this.searchEffects(next.view.state, true) });
  }

  /* ---------- 本文・状態の取得 ---------- */

  getContent(id: string): string {
    const entry = this.entries.get(id);
    if (!entry) return '';
    const view = this.liveView(id);
    if (view) return view.state.doc.toString();
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
    return this.liveView(id)?.state ?? entry.state ?? entry.content ?? '';
  }

  /** 本文の長さ（EditorState を作らずに取得） */
  getLength(id: string): number {
    const entry = this.entries.get(id);
    if (!entry) return 0;
    const view = this.liveView(id);
    if (view) return view.state.doc.length;
    if (entry.state) return entry.state.doc.length;
    return entry.content?.length ?? 0;
  }

  getSelection(id: string): SelectionJSON | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const state = this.liveView(id)?.state ?? entry.state;
    if (state) return state.selection.toJSON() as SelectionJSON;
    return entry.restore?.selection;
  }

  getScrollPos(id: string): number {
    const entry = this.entries.get(id);
    if (!entry) return 0;
    const view = this.liveView(id);
    return view ? topVisiblePos(view) : entry.scrollPos;
  }

  /**
   * タブに変更を適用する（表示していないタブにも適用可能）。
   * 変更は各タブの Undo 履歴に記録される。
   */
  applyToTab(id: string, build: (state: EditorState) => TransactionSpec | null): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const spec = build(this.currentState(entry));
    if (!spec) return false;
    const view = this.liveView(id);
    if (view) {
      view.dispatch(spec);
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
    const view = this.liveView(entry.id);
    if (view) {
      view.dispatch({ effects });
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

  /** 設定を反映する（表示中のタブは直ちに、非表示のタブは次に表示するときに反映） */
  applySettings(settings: Settings): void {
    this.settings = settings;
    this.configGeneration++;
    for (const pane of this.panes) {
      if (!pane) continue;
      const entry = pane.tabId ? this.entries.get(pane.tabId) : undefined;
      if (entry) {
        pane.view.dispatch({ effects: this.reconfigureEffects(entry) });
        entry.configGeneration = this.configGeneration;
      } else {
        pane.view.setState(this.emptyState());
      }
    }
    this.requestMeasure();
  }

  /** レイアウト変更後に各ペインの寸法を測り直す */
  requestMeasure(): void {
    for (const pane of this.panes) pane?.view.requestMeasure();
  }

  /* ---------- 検索 ---------- */

  private searchEffects(state: EditorState, active: boolean): StateEffect<unknown>[] {
    const effects: StateEffect<unknown>[] = [];
    if (this.searchQuery) effects.push(setSearchQuery.of(this.searchQuery));
    const highlight = active && this.searchActive;
    if (state.field(searchActiveField, false) !== highlight) {
      effects.push(setSearchActive.of(highlight));
    }
    return effects;
  }

  /** 検索条件をアクティブなペインに反映する（ペイン・タブの切り替え時にも引き継ぐ） */
  setSearch(query: SearchQuery | null, active: boolean): void {
    this.searchQuery = query;
    this.searchActive = active;
    const pane = this.panes[this.activePane];
    if (pane?.tabId) pane.view.dispatch({ effects: this.searchEffects(pane.view.state, true) });
  }

  focus(): void {
    this.panes[this.activePane]?.view.focus();
  }

  /* ---------- 差分表示 ---------- */

  /**
   * タブに差分の強調表示を設定する（null で解除）。本文・Undo 履歴・選択範囲は変更しない。
   * 表示していないタブにも設定できる。
   */
  setDiffMarks(id: string, marks: DecorationSet | null): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const view = this.liveView(id);
    if (view) {
      if (marks || view.state.field(diffMarksField, false)?.size) view.dispatch(diffMarksSpec(marks ?? Decoration.none));
    } else if (entry.state) {
      entry.state = entry.state.update(diffMarksSpec(marks ?? Decoration.none)).state;
    }
  }

  /** 画面上端に表示されている行（1 始まり。行の途中までを小数で表す）。表示していなければ null */
  getTopLine(id: string): number | null {
    const view = this.liveView(id);
    if (!view || view.state.doc.length === 0) return view ? 1 : null;
    const top = view.scrollDOM.scrollTop;
    const block = view.lineBlockAtHeight(top);
    const line = view.state.doc.lineAt(block.from).number;
    return line + (block.height > 0 ? Math.min(1, Math.max(0, (top - block.top) / block.height)) : 0);
  }

  /** 指定行（小数可）が画面上端に来るスクロール位置。offset 分だけ手前（上）に余白を取る */
  scrollTopForLine(id: string, line: number, offset = 0): number {
    const view = this.liveView(id);
    if (!view) return 0;
    const doc = view.state.doc;
    const n = Math.min(Math.max(1, Math.floor(line)), doc.lines);
    const block = view.lineBlockAt(doc.line(n).from);
    const frac = line >= doc.lines + 1 ? 1 : Math.max(0, line - n);
    return Math.max(0, block.top + frac * block.height - offset);
  }

  getScrollTop(id: string): number {
    return this.liveView(id)?.scrollDOM.scrollTop ?? 0;
  }

  /** スクロール位置を設定し、実際に設定された位置（範囲外は丸められる）を返す */
  setScrollTop(id: string, top: number): number {
    const view = this.liveView(id);
    if (!view) return 0;
    view.scrollDOM.scrollTop = top;
    // 表示した直後のビューは、スクロールイベントでは表示範囲を更新しないことがあるため、明示的に測り直す
    view.requestMeasure();
    return view.scrollDOM.scrollTop;
  }

  getViewportHeight(id: string): number {
    return this.liveView(id)?.scrollDOM.clientHeight ?? 0;
  }

  /** 指定位置を選択してスクロールする（タブを表示しているペインで行う） */
  select(id: string, anchor: number, head = anchor): void {
    const view = this.liveView(id);
    if (!view) return;
    const len = view.state.doc.length;
    const range = EditorSelection.range(Math.min(anchor, len), Math.min(head, len));
    view.dispatch({
      selection: EditorSelection.create([range]),
      effects: EditorView.scrollIntoView(range, { y: 'center' }),
      userEvent: 'select',
    });
  }
}

/** 画面上端に表示されている文書内位置 */
function topVisiblePos(view: EditorView): number {
  if (view.state.doc.length === 0) return 0;
  try {
    const top = view.scrollDOM.scrollTop;
    if (top <= 0) return 0;
    return view.lineBlockAtHeight(top).from;
  } catch {
    return 0;
  }
}
