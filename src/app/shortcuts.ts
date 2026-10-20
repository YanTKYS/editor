/** アプリ全体のキーボードショートカット */
export type CommandId =
  | 'newTab'
  | 'openFile'
  | 'saveBrowser'
  | 'exportFile'
  | 'find'
  | 'replace'
  | 'findNext'
  | 'findPrevious'
  | 'findInTabs'
  | 'gotoLine'
  | 'nextTab'
  | 'prevTab'
  | 'closeTab'
  | 'reopenTab'
  | 'renameTab'
  | 'toggleWrap'
  | 'togglePreview'
  | 'focusPane1'
  | 'focusPane2'
  | 'focusPane3'
  | 'focusPane4';

export interface Binding {
  command: CommandId;
  /** 例: "Ctrl+Shift+S"（修飾キーの順序は Ctrl, Alt, Shift） */
  keys: string[];
  /** ブラウザに奪われる可能性があるキー（表示上の注記に使う） */
  browserReserved?: string[];
}

/**
 * Ctrl+N / Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+W 等はブラウザが優先するため、
 * Web ページからは受け取れない場合がある。そのため Alt 系の代替キーを併せて割り当てる。
 */
export const BINDINGS: Binding[] = [
  { command: 'newTab', keys: ['Ctrl+N', 'Alt+N'], browserReserved: ['Ctrl+N'] },
  { command: 'openFile', keys: ['Ctrl+O'] },
  { command: 'saveBrowser', keys: ['Ctrl+S'] },
  { command: 'exportFile', keys: ['Ctrl+Shift+S'] },
  { command: 'find', keys: ['Ctrl+F'] },
  { command: 'replace', keys: ['Ctrl+H'] },
  { command: 'findNext', keys: ['F3'] },
  { command: 'findPrevious', keys: ['Shift+F3'] },
  { command: 'findInTabs', keys: ['Ctrl+Shift+F'] },
  { command: 'gotoLine', keys: ['Ctrl+G'] },
  {
    command: 'nextTab',
    keys: ['Ctrl+Tab', 'Alt+PageDown', 'Ctrl+PageDown'],
    browserReserved: ['Ctrl+Tab', 'Ctrl+PageDown'],
  },
  {
    command: 'prevTab',
    keys: ['Ctrl+Shift+Tab', 'Alt+PageUp', 'Ctrl+PageUp'],
    browserReserved: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'],
  },
  { command: 'closeTab', keys: ['Alt+W'] },
  { command: 'reopenTab', keys: ['Alt+Shift+T'] },
  { command: 'renameTab', keys: ['F2'] },
  { command: 'toggleWrap', keys: ['Alt+Z'] },
  { command: 'togglePreview', keys: ['Alt+P'] },
  { command: 'focusPane1', keys: ['Alt+1'] },
  { command: 'focusPane2', keys: ['Alt+2'] },
  { command: 'focusPane3', keys: ['Alt+3'] },
  { command: 'focusPane4', keys: ['Alt+4'] },
];

/** キーイベントを "Ctrl+Shift+S" 形式の文字列にする（Mac の Cmd は Ctrl とみなす） */
export function eventToKey(e: KeyboardEvent): string {
  let key = e.key;
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return '';
  // Alt 併用時に e.key が特殊文字になる配列（Mac 等）に備えて e.code から英字を得る
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

const KEY_TO_COMMAND = new Map<string, CommandId>();
for (const b of BINDINGS) for (const k of b.keys) KEY_TO_COMMAND.set(k, b.command);

export function commandForEvent(e: KeyboardEvent): CommandId | null {
  if (e.isComposing) return null;
  return KEY_TO_COMMAND.get(eventToKey(e)) ?? null;
}

/** メニュー表示用のショートカット表記（最初の 2 つまで） */
export function shortcutLabel(command: CommandId): string {
  const b = BINDINGS.find((x) => x.command === command);
  return b ? b.keys.slice(0, 2).join(' / ') : '';
}
