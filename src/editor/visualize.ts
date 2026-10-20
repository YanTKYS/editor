import { Facet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import { getSearchQuery } from '@codemirror/search';
import type { LineEnding } from '../core/types';

/* ---------- 改行コードの可視化 ---------- */

/** タブごとの改行コード（表示用） */
export const eolFacet = Facet.define<LineEnding, LineEnding>({
  combine: (values) => values[0] ?? 'LF',
});

class EolWidget extends WidgetType {
  constructor(readonly label: LineEnding) {
    super();
  }
  override eq(other: EolWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-eolMarker';
    span.textContent = this.label === 'CRLF' ? 'CRLF' : this.label;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function buildEolDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const widget = Decoration.widget({ widget: new EolWidget(view.state.facet(eolFacet)), side: 1 });
  const doc = view.state.doc;
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (line.number < doc.lines && line.to > last) {
        builder.add(line.to, line.to, widget);
        last = line.to;
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** 各行末に改行コードを表示する拡張 */
export const showLineEndings = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildEolDecorations(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.startState.facet(eolFacet) !== u.state.facet(eolFacet)
      ) {
        this.decorations = buildEolDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/* ---------- 検索一致箇所の強調 ---------- */

/** 検索パネルが開いているか（開いている間だけ一致箇所を強調表示する） */
export const setSearchActive = StateEffect.define<boolean>();

export const searchActiveField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSearchActive)) value = e.value;
    return value;
  },
});

const matchMark = Decoration.mark({ class: 'cm-searchMatch' });
const selectedMatchMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });
const HIGHLIGHT_MARGIN = 250;
const HIGHLIGHT_LIMIT = 2000;

function buildSearchDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  if (!state.field(searchActiveField, false)) return Decoration.none;
  const query = getSearchQuery(state);
  if (!query.valid) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const sel = state.selection.main;
  let lastTo = -1;
  let count = 0;
  for (const { from, to } of view.visibleRanges) {
    const cursor = query.getCursor(
      state,
      Math.max(0, from - HIGHLIGHT_MARGIN),
      Math.min(state.doc.length, to + HIGHLIGHT_MARGIN),
    );
    for (let r = cursor.next(); !r.done; r = cursor.next()) {
      const m = r.value;
      if (m.from < lastTo || m.from === m.to) continue;
      const selected = m.from === sel.from && m.to === sel.to;
      builder.add(m.from, m.to, selected ? selectedMatchMark : matchMark);
      lastTo = m.to;
      if (++count > HIGHLIGHT_LIMIT) return builder.finish();
    }
  }
  return builder.finish();
}

/** 検索一致箇所を強調表示する拡張（CodeMirror 標準の検索パネルは使用しない） */
export const searchHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildSearchDecorations(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        getSearchQuery(u.startState) !== getSearchQuery(u.state) ||
        u.startState.field(searchActiveField, false) !== u.state.field(searchActiveField, false)
      ) {
        this.decorations = buildSearchDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
