import type { EditorMode } from './types';

export interface ModeInfo {
  id: EditorMode;
  label: string;
  /** 書き出し時に拡張子がない場合に付与する拡張子 */
  defaultExt: string;
  extensions: readonly string[];
}

export const MODES: readonly ModeInfo[] = [
  { id: 'plaintext', label: 'Plain Text', defaultExt: 'txt', extensions: ['txt', 'text', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf'] },
  { id: 'markdown', label: 'Markdown', defaultExt: 'md', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
  { id: 'json', label: 'JSON', defaultExt: 'json', extensions: ['json', 'jsonc', 'json5', 'webmanifest', 'map'] },
  { id: 'javascript', label: 'JavaScript', defaultExt: 'js', extensions: ['js', 'mjs', 'cjs', 'jsx'] },
  { id: 'typescript', label: 'TypeScript', defaultExt: 'ts', extensions: ['ts', 'mts', 'cts', 'tsx'] },
  { id: 'html', label: 'HTML', defaultExt: 'html', extensions: ['html', 'htm', 'xhtml', 'vue', 'svelte'] },
  { id: 'css', label: 'CSS', defaultExt: 'css', extensions: ['css', 'scss', 'less'] },
  { id: 'xml', label: 'XML', defaultExt: 'xml', extensions: ['xml', 'xsd', 'xsl', 'xslt', 'svg', 'rss', 'atom', 'config', 'csproj', 'plist'] },
];

const MODE_BY_ID = new Map(MODES.map((m) => [m.id, m]));
const MODE_BY_EXT = new Map<string, EditorMode>();
for (const m of MODES) for (const ext of m.extensions) MODE_BY_EXT.set(ext, m.id);

export function isEditorMode(value: unknown): value is EditorMode {
  return typeof value === 'string' && MODE_BY_ID.has(value as EditorMode);
}

export function modeInfo(mode: EditorMode): ModeInfo {
  return MODE_BY_ID.get(mode) ?? MODES[0];
}

/** ファイル名の拡張子（小文字、ドットなし）。拡張子がなければ空文字 */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** ファイル名から編集モードを判定する。判定できない場合は Plain Text */
export function detectMode(name: string): EditorMode {
  return MODE_BY_EXT.get(fileExtension(name)) ?? 'plaintext';
}
