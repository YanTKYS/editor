import type { LineEnding } from './types';

export const EOL_STRING: Readonly<Record<LineEnding, string>> = {
  LF: '\n',
  CRLF: '\r\n',
  CR: '\r',
};

export interface LineEndingInfo {
  /** 最も多く使われている改行コード（改行がなければ fallback） */
  eol: LineEnding;
  /** 複数種類の改行コードが混在しているか */
  mixed: boolean;
  counts: Record<LineEnding, number>;
}

export function detectLineEnding(text: string, fallback: LineEnding = 'LF'): LineEndingInfo {
  const counts: Record<LineEnding, number> = { LF: 0, CRLF: 0, CR: 0 };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        counts.CRLF++;
        i++;
      } else {
        counts.CR++;
      }
    } else if (c === 10) {
      counts.LF++;
    }
  }
  const kinds = (Object.keys(counts) as LineEnding[]).filter((k) => counts[k] > 0);
  let eol: LineEnding = fallback;
  if (kinds.length > 0) {
    eol = kinds.reduce((a, b) => (counts[b] > counts[a] ? b : a));
  }
  return { eol, mixed: kinds.length > 1, counts };
}

/** すべての改行を LF に正規化する（エディタ内部表現） */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** LF で正規化されたテキストを指定の改行コードに変換する */
export function applyLineEnding(text: string, eol: LineEnding): string {
  if (eol === 'LF') return text;
  return text.replace(/\n/g, EOL_STRING[eol]);
}

export function isLineEnding(value: unknown): value is LineEnding {
  return value === 'LF' || value === 'CRLF' || value === 'CR';
}
