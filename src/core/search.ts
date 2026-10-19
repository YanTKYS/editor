import { SearchQuery } from '@codemirror/search';
import { EditorState, Text, type ChangeSpec } from '@codemirror/state';

/** 検索条件（UI の入力値） */
export interface SearchOptions {
  search: string;
  replace: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

export const EMPTY_SEARCH: SearchOptions = {
  search: '',
  replace: '',
  caseSensitive: false,
  regexp: false,
  wholeWord: false,
};

/**
 * CodeMirror の SearchQuery を作成する。
 * 通常検索ではエスケープ解釈をしない（入力した文字列そのものを検索）。
 * 正規表現モードでは置換文字列中の \n \t \\ と $1 $& $$ を解釈する。
 */
export function createQuery(opts: SearchOptions): SearchQuery {
  return new SearchQuery({
    search: opts.search,
    replace: opts.replace,
    caseSensitive: opts.caseSensitive,
    regexp: opts.regexp,
    wholeWord: opts.wholeWord,
    literal: !opts.regexp,
  });
}

/** 正規表現の構文エラーメッセージ（正常または通常検索なら null） */
export function regexpError(opts: SearchOptions): string | null {
  if (!opts.regexp || !opts.search) return null;
  try {
    new RegExp(opts.search, 'u');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

interface RawMatch {
  from: number;
  to: number;
  match?: RegExpExecArray | null;
}

function unquoteReplacement(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\',
  );
}

/** 置換後の文字列を求める（CodeMirror の replaceNext と同じ規則） */
export function replacementFor(query: SearchQuery, m: RawMatch): string {
  if (!query.regexp) return query.replace;
  const match = m.match;
  return unquoteReplacement(query.replace).replace(/\$([$&]|\d+)/g, (whole, i: string) => {
    if (!match) return whole;
    if (i === '&') return match[0];
    if (i === '$') return '$';
    for (let l = i.length; l > 0; l--) {
      const n = Number(i.slice(0, l));
      if (n > 0 && n < match.length) return (match[n] ?? '') + i.slice(l);
    }
    return whole;
  });
}

function toState(doc: EditorState | Text | string): EditorState {
  if (doc instanceof EditorState) return doc;
  return EditorState.create({ doc: typeof doc === 'string' ? doc : doc });
}

/** 一致箇所を列挙する（limit を超えたら打ち切り） */
export function* iterateMatches(
  query: SearchQuery,
  doc: EditorState | Text | string,
): Generator<RawMatch> {
  if (!query.valid) return;
  const state = toState(doc);
  const cursor = query.getCursor(state) as Iterator<RawMatch> & { next(): IteratorResult<RawMatch> };
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    yield { from: r.value.from, to: r.value.to, match: r.value.match };
  }
}

export interface MatchCount {
  total: number;
  /** limit に達して打ち切ったか */
  capped: boolean;
  /** 指定範囲（主選択）と一致する結果の番号（1 始まり。なければ 0） */
  current: number;
}

export function countMatches(
  query: SearchQuery,
  state: EditorState,
  limit = 10000,
): MatchCount {
  const sel = state.selection.main;
  let total = 0;
  let current = 0;
  for (const m of iterateMatches(query, state)) {
    total++;
    if (m.from === sel.from && m.to === sel.to) current = total;
    if (total >= limit) return { total, capped: true, current };
  }
  return { total, capped: false, current };
}

/** すべて置換するための変更内容と件数 */
export function buildReplaceAll(
  query: SearchQuery,
  state: EditorState | Text | string,
): { changes: ChangeSpec[]; count: number } {
  const changes: ChangeSpec[] = [];
  for (const m of iterateMatches(query, state)) {
    changes.push({ from: m.from, to: m.to, insert: replacementFor(query, m) });
  }
  return { changes, count: changes.length };
}

/** 横断検索の結果 1 件 */
export interface DocMatch {
  from: number;
  to: number;
  line: number;
  /** 1 始まりの列 */
  column: number;
  /** 該当行のテキスト（長い場合は前後を省略） */
  preview: string;
  /** preview 内での一致部分の位置 */
  previewFrom: number;
  previewTo: number;
}

const PREVIEW_CONTEXT = 60;

/** 文書内の一致箇所を行情報付きで返す */
export function findInDocument(
  query: SearchQuery,
  doc: EditorState | Text | string,
  limit = 1000,
): { matches: DocMatch[]; total: number; capped: boolean } {
  const state = toState(doc);
  const matches: DocMatch[] = [];
  let total = 0;
  for (const m of iterateMatches(query, state)) {
    total++;
    if (matches.length < limit) {
      const line = state.doc.lineAt(m.from);
      const colStart = m.from - line.from;
      const matchEndInLine = Math.min(m.to, line.to) - line.from;
      const start = Math.max(0, colStart - PREVIEW_CONTEXT);
      const end = Math.min(line.length, Math.max(matchEndInLine, colStart) + PREVIEW_CONTEXT);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < line.length ? '…' : '';
      const preview = prefix + line.text.slice(start, end) + suffix;
      matches.push({
        from: m.from,
        to: m.to,
        line: line.number,
        column: colStart + 1,
        preview,
        previewFrom: prefix.length + colStart - start,
        previewTo: prefix.length + matchEndInLine - start,
      });
    } else if (total >= limit * 20) {
      // 件数表示のための走査も過大にならないよう打ち切る
      return { matches, total, capped: true };
    }
  }
  return { matches, total, capped: false };
}
