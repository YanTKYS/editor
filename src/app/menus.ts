import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  toggleComment,
  undo,
} from '@codemirror/commands';
import { foldAll, unfoldAll } from '@codemirror/language';
import { selectNextOccurrence } from '@codemirror/search';
import { MODES } from '../core/modes';
import { alertDialog } from '../ui/dialogs';
import { h } from '../ui/dom';
import type { MenuDefinition } from '../ui/menuBar';
import type { MenuItem } from '../ui/popupMenu';
import { APP_NAME, APP_VERSION, type App } from './app';
import { BINDINGS, shortcutLabel, type CommandId } from './shortcuts';

const COMMAND_LABELS: Record<CommandId, string> = {
  newTab: '新規タブ',
  openFile: 'ファイルを開く',
  saveBrowser: 'ブラウザ内に保存',
  exportFile: 'ファイルに書き出し（ダウンロード）',
  find: '検索',
  replace: '置換',
  findNext: '次を検索',
  findPrevious: '前を検索',
  findInTabs: 'すべてのタブから検索',
  gotoLine: '指定行へ移動',
  nextTab: '次のタブ',
  prevTab: '前のタブ',
  closeTab: 'タブを閉じる',
  reopenTab: '閉じたタブを開き直す',
  renameTab: 'タブ名の変更',
  toggleWrap: '右端で折り返す',
  togglePreview: 'Markdown プレビュー',
  diffNext: '次の差分',
  diffPrev: '前の差分',
  focusPane1: 'ペイン 1 へ移動',
  focusPane2: 'ペイン 2 へ移動',
  focusPane3: 'ペイン 3 へ移動',
  focusPane4: 'ペイン 4 へ移動',
};

const SPLIT_LABELS = ['1 画面', '2 分割', '3 分割', '4 分割'];

export function buildMenus(app: App): MenuDefinition[] {
  const cmd = (command: CommandId, label = COMMAND_LABELS[command], extra: Partial<MenuItem> = {}): MenuItem =>
    ({ label, shortcut: shortcutLabel(command), action: () => app.run(command), ...extra }) as MenuItem;
  const edit = (label: string, run: Parameters<App['runEditorCommand']>[0], shortcut?: string): MenuItem => ({
    label,
    shortcut,
    action: () => app.runEditorCommand(run),
  });
  const s = () => app.settings;

  return [
    {
      id: 'file',
      label: 'ファイル',
      items: () => [
        cmd('newTab', '新規タブ'),
        cmd('openFile', 'ファイルを開く…'),
        {
          label: 'Shift_JIS のファイルを開く…',
          action: () => void app.files.openWithPicker('Shift_JIS'),
          hint: 'Shift_JIS（CP932）で書かれたファイルを読み込みます。書き出しは UTF-8 になります。',
        },
        { separator: true },
        { heading: 'ブラウザ内保存（自動保存されます）' },
        cmd('saveBrowser', '今すぐブラウザ内に保存'),
        { label: '保存領域の情報…', action: () => void app.files.showStorageInfo() },
        { separator: true },
        { heading: 'PC へのファイル書き出し' },
        cmd('exportFile', 'ファイルに書き出し'),
        { label: '名前を付けて書き出し…', action: () => void app.files.exportActive(true) },
        { separator: true },
        { label: 'バックアップを書き出し（全タブ・設定 JSON）', action: () => app.files.exportBackup() },
        { label: 'バックアップから復元…', action: () => void app.files.importBackup() },
        { separator: true },
        cmd('renameTab', 'タブ名の変更…'),
        cmd('closeTab'),
        {
          label: '他のタブをすべて閉じる',
          disabled: app.store.count <= 1,
          action: () => app.store.activeTabId && void app.closeOtherTabs(app.store.activeTabId),
        },
        cmd('reopenTab', undefined, { disabled: !app.canReopenTab }),
      ],
    },
    {
      id: 'edit',
      label: '編集',
      items: () => [
        edit('元に戻す', undo, 'Ctrl+Z'),
        edit('やり直し', redo, 'Ctrl+Y'),
        { separator: true },
        edit('すべて選択', selectAll, 'Ctrl+A'),
        edit('次の一致を選択に追加', selectNextOccurrence, 'Ctrl+D'),
        edit('上にカーソルを追加', addCursorAbove, 'Ctrl+Alt+↑'),
        edit('下にカーソルを追加', addCursorBelow, 'Ctrl+Alt+↓'),
        { separator: true },
        edit('行を複製', copyLineDown, 'Shift+Alt+↓'),
        edit('行を上へ移動', moveLineUp, 'Alt+↑'),
        edit('行を下へ移動', moveLineDown, 'Alt+↓'),
        edit('行を削除', deleteLine, 'Ctrl+Shift+K'),
        { separator: true },
        edit('インデントを増やす', indentMore, 'Ctrl+]'),
        edit('インデントを減らす', indentLess, 'Ctrl+['),
        edit('コメントの切り替え', toggleComment, 'Ctrl+/'),
        { separator: true },
        edit('すべて折りたたむ', foldAll, 'Ctrl+Alt+['),
        edit('すべて展開', unfoldAll, 'Ctrl+Alt+]'),
      ],
    },
    {
      id: 'search',
      label: '検索',
      items: () => [
        cmd('find', '検索…'),
        cmd('replace', '置換…'),
        cmd('findNext'),
        cmd('findPrevious'),
        cmd('findInTabs', 'すべてのタブから検索…'),
        { separator: true },
        cmd('gotoLine', '指定行へ移動…'),
      ],
    },
    {
      id: 'view',
      label: '表示',
      items: () => [
        cmd('toggleWrap', undefined, { checked: s().wordWrap }),
        {
          label: '行番号',
          checked: s().lineNumbers,
          action: () => app.updateSettings({ lineNumbers: !s().lineNumbers }),
        },
        {
          label: 'スペース・タブを表示',
          checked: s().showWhitespace,
          action: () => app.updateSettings({ showWhitespace: !s().showWhitespace }),
        },
        {
          label: '改行コードを表示',
          checked: s().showLineEndings,
          action: () => app.updateSettings({ showLineEndings: !s().showLineEndings }),
        },
        cmd('togglePreview', 'Markdown プレビュー', { checked: s().markdownPreview }),
        { separator: true },
        { heading: '画面分割（左右に等幅で並べる）' },
        ...SPLIT_LABELS.map((label, i) => ({
          label,
          checked: app.layout.count === i + 1,
          action: () => app.setPaneCount(i + 1),
        })),
        ...(app.layout.count > 1
          ? (['focusPane1', 'focusPane2', 'focusPane3', 'focusPane4'] as const)
              .slice(0, app.layout.count)
              .map((c) => cmd(c, undefined, { checked: app.layout.active === Number(c.slice(-1)) - 1 }))
          : []),
        { separator: true },
        { heading: '差分比較（比較元・比較先・結果）' },
        { label: '差分比較…', action: () => void app.openDiffDialog() },
        ...(app.diff.active
          ? [
              cmd('diffPrev'),
              cmd('diffNext'),
              { label: '比較終了', action: () => app.endDiff() } as MenuItem,
            ]
          : []),
        { separator: true },
        { label: '文字を大きく', shortcut: `${s().fontSize}px`, action: () => app.changeFontSize(1) },
        { label: '文字を小さく', action: () => app.changeFontSize(-1) },
        { label: '文字サイズを標準に戻す', action: () => app.changeFontSize('reset') },
        { separator: true },
        { label: 'ライトテーマ', checked: s().theme === 'light', action: () => app.updateSettings({ theme: 'light' }) },
        { label: 'ダークテーマ', checked: s().theme === 'dark', action: () => app.updateSettings({ theme: 'dark' }) },
        { separator: true },
        cmd('nextTab'),
        cmd('prevTab'),
        { label: 'タブを左へ移動', action: () => app.moveActiveTab(-1) },
        { label: 'タブを右へ移動', action: () => app.moveActiveTab(1) },
      ],
    },
    {
      id: 'language',
      label: '言語',
      items: () => {
        const current = app.store.active?.mode;
        return MODES.map((m) => ({
          label: m.label,
          checked: m.id === current,
          action: () => app.setMode(m.id),
        }));
      },
    },
    {
      id: 'settings',
      label: '設定',
      items: () => [
        { heading: 'インデント' },
        {
          label: 'スペースを使う',
          checked: !s().indentWithTabs,
          action: () => app.updateSettings({ indentWithTabs: false }),
        },
        {
          label: 'タブ文字を使う',
          checked: s().indentWithTabs,
          action: () => app.updateSettings({ indentWithTabs: true }),
        },
        { heading: 'タブ幅' },
        ...[2, 4, 8].map((n) => ({
          label: `${n} 文字`,
          checked: s().tabSize === n,
          action: () => app.updateSettings({ tabSize: n }),
        })),
        { separator: true },
        { heading: '改行コード（現在のタブの書き出し時）' },
        ...(['CRLF', 'LF', 'CR'] as const).map((eol) => ({
          label: eol,
          checked: app.store.active?.eol === eol,
          action: () => app.setEol(eol),
        })),
      ],
    },
    {
      id: 'help',
      label: 'ヘルプ',
      items: () => [
        { label: 'キーボードショートカット', action: () => void showShortcutHelp() },
        { label: `${APP_NAME} について`, action: () => void showAbout() },
      ],
    },
  ];
}

/** メニュー下の主要操作ボタン */
export function buildToolbar(app: App): HTMLElement {
  const button = (label: string, title: string, onClick: () => void, cls = '') =>
    h('button', {
      class: `toolbar-button ${cls}`.trim(),
      text: label,
      type: 'button',
      title,
      on: { click: onClick },
    });
  const sep = () => h('span', { class: 'toolbar-sep', attrs: { 'aria-hidden': 'true' } });
  return h('div', { class: 'toolbar', attrs: { role: 'toolbar', 'aria-label': '主要操作' } }, [
    button('新規', '新規タブ (Ctrl+N / Alt+N)', () => app.run('newTab')),
    button('開く', 'ファイルを開く (Ctrl+O)', () => app.run('openFile')),
    sep(),
    button('ブラウザに保存', 'ブラウザ内（localStorage）に保存 (Ctrl+S)\n※編集内容は自動保存されます', () => app.run('saveBrowser'), 'tb-save'),
    button('ファイルに書き出し', '現在のタブを PC にダウンロード (Ctrl+Shift+S)', () => app.run('exportFile'), 'tb-export'),
    sep(),
    button('元に戻す', '元に戻す (Ctrl+Z)', () => app.runEditorCommand(undo)),
    button('やり直し', 'やり直し (Ctrl+Y)', () => app.runEditorCommand(redo)),
    sep(),
    button('検索', '検索 (Ctrl+F)', () => app.run('find')),
    button('置換', '置換 (Ctrl+H)', () => app.run('replace')),
    sep(),
    sep(),
    h(
      'span',
      { class: 'split-toggle', attrs: { role: 'group', 'aria-label': '画面分割' } },
      [
        h('span', { class: 'split-label', text: '分割', attrs: { 'aria-hidden': 'true' } }),
        ...SPLIT_LABELS.map((label, i) =>
          h('button', {
            class: 'split-button',
            text: String(i + 1),
            type: 'button',
            title: label,
            dataset: { split: String(i + 1) },
            attrs: { 'aria-label': label, 'aria-pressed': String(i === 0) },
            on: { click: () => app.setPaneCount(i + 1) },
          }),
        ),
      ],
    ),
    sep(),
    button('折り返し', '右端で折り返す (Alt+Z)', () => app.run('toggleWrap'), 'tb-optional'),
    button('プレビュー', 'Markdown プレビュー (Alt+P)', () => app.run('togglePreview'), 'tb-optional'),
  ]);
}

async function showShortcutHelp(): Promise<void> {
  const rows: [string, string][] = BINDINGS.map((b) => [
    COMMAND_LABELS[b.command],
    b.keys.join(' / ') + (b.browserReserved?.length ? ' ※' : ''),
  ]);
  rows.push(
    ['元に戻す / やり直し', 'Ctrl+Z / Ctrl+Y（Ctrl+Shift+Z）'],
    ['次の一致を選択に追加', 'Ctrl+D'],
    ['複数カーソル', 'Ctrl+クリック、Alt+ドラッグ（矩形選択）、Ctrl+Alt+↑/↓'],
    ['行の複製', 'Shift+Alt+↓ / ↑'],
    ['行の移動', 'Alt+↑ / ↓'],
    ['行の削除', 'Ctrl+Shift+K'],
    ['インデント', 'Tab / Shift+Tab、Ctrl+] / Ctrl+['],
    ['コメントの切り替え', 'Ctrl+/'],
    ['エディタからフォーカスを移す', 'Esc を押してから Tab'],
    ['タブバーでの操作', '←/→ 移動、Enter 編集へ、F2 名前変更、Delete 閉じる、Alt+Shift+←/→ 並べ替え'],
  );
  const table = h(
    'table',
    { class: 'info-table shortcut-table' },
    rows.map(([k, v]) => h('tr', {}, [h('th', { text: k }), h('td', { text: v })])),
  );
  const note = h('p', {
    class: 'dialog-note',
    text: '※ Ctrl+N・Ctrl+Tab・Ctrl+W などはブラウザの操作が優先され、Web ページでは受け取れない場合があります。その場合は併記した Alt 系のキーを使ってください。',
  });
  await alertDialog('キーボードショートカット', h('div', {}, [table, note]));
}

async function showAbout(): Promise<void> {
  await alertDialog(
    `${APP_NAME} について`,
    `${APP_NAME} v${APP_VERSION}\nCodeMirror 6 を利用したタブ型テキストエディタです。\n編集内容はこのブラウザ内（localStorage）に自動保存され、サーバーへは送信されません。`,
  );
}
