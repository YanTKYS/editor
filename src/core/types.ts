/** 編集モード（構文ハイライトの種類） */
export type EditorMode =
  | 'plaintext'
  | 'markdown'
  | 'json'
  | 'javascript'
  | 'typescript'
  | 'html'
  | 'css'
  | 'xml';

/** 改行コード */
export type LineEnding = 'LF' | 'CRLF' | 'CR';

/** 読み込み時の文字コード（書き出しは常に UTF-8） */
export type SourceEncoding = 'UTF-8' | 'Shift_JIS';

export type ThemeName = 'light' | 'dark';

/** 選択範囲（CodeMirror の EditorSelection.toJSON と互換） */
export interface SelectionJSON {
  ranges: { anchor: number; head: number }[];
  main: number;
}

/** タブのメタ情報（本文以外） */
export interface TabMeta {
  id: string;
  name: string;
  mode: EditorMode;
  eol: LineEnding;
  encoding: SourceEncoding;
  /** 読み込み元に BOM があったか（書き出し時に維持） */
  bom: boolean;
  /** 最後にファイルとして読み込み/書き出しした後に変更されたか */
  modifiedSinceFile: boolean;
  createdAt: number;
  updatedAt: number;
}

/** ブラウザ内保存用のタブ情報（本文は別キーに保存） */
export interface PersistedTabMeta extends TabMeta {
  selection?: SelectionJSON;
  /** 画面上端に表示されていた位置（文書内オフセット） */
  scrollPos?: number;
}

export interface Settings {
  theme: ThemeName;
  fontSize: number;
  tabSize: number;
  indentWithTabs: boolean;
  wordWrap: boolean;
  lineNumbers: boolean;
  showWhitespace: boolean;
  showLineEndings: boolean;
  markdownPreview: boolean;
  /** プレビュー領域の幅（エディタ領域に対する割合 0.15〜0.85） */
  previewRatio: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  theme: 'light',
  fontSize: 14,
  tabSize: 4,
  indentWithTabs: false,
  wordWrap: false,
  lineNumbers: true,
  showWhitespace: false,
  showLineEndings: false,
  markdownPreview: true,
  previewRatio: 0.5,
});

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 40;
export const TAB_SIZE_MIN = 1;
export const TAB_SIZE_MAX = 16;
