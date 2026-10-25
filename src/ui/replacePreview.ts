import {
  REPLACE_PREVIEW_CHARS,
  REPLACE_PREVIEW_FILES,
  REPLACE_PREVIEW_MATCHES,
  type ReplacementExample,
} from '../core/search';
import { showDialog } from './dialogs';
import { h } from './dom';

export interface ReplacementFilePreview {
  name: string;
  tabNumber: number;
  count: number;
  examples: ReplacementExample[];
}

/** 表示例は制限するが、確定時の対象は省略分を含む全件。 */
export function showReplacePreview(
  files: ReplacementFilePreview[],
  total: number,
  validate: () => string | null,
): Promise<boolean> {
  const list = h('div', { class: 'replace-preview-list' });
  for (const file of files.slice(0, REPLACE_PREVIEW_FILES)) {
    const group = h('section', { class: 'replace-preview-file' }, [
      h('h3', { text: `タブ ${file.tabNumber} — ${file.name}（${file.count.toLocaleString()} 件）` }),
    ]);
    for (const example of file.examples) {
      const pair = (label: string, value: string) => h('div', {}, [
        h('span', { class: 'replace-preview-label', text: label }),
        h('pre', { text: value || '（空文字）' }),
      ]);
      group.append(h('div', { class: 'replace-preview-example' }, [
        h('p', { text: `行 ${example.line}, 列 ${example.column}（置換前）` }),
        h('pre', { class: 'replace-preview-context', text: `行の抜粋：${example.context}` }),
        h('div', { class: 'replace-preview-pair' }, [pair('変更前', example.before), pair('変更後', example.after)]),
      ]));
    }
    if (file.count > file.examples.length) {
      group.append(h('p', { class: 'dialog-note', text: `ほか ${file.count - file.examples.length} 件は表示を省略しています。` }));
    }
    list.append(group);
  }
  if (files.length > REPLACE_PREVIEW_FILES) {
    list.append(h('p', { text: `ほか ${files.length - REPLACE_PREVIEW_FILES} タブは表示を省略しています。` }));
  }
  return showDialog<boolean>({
    title: 'すべてのタブで置換',
    className: 'dialog-replace-preview',
    body: h('div', {}, [
      h('p', { class: 'replace-preview-summary', text: `${files.length} 個のタブで合計 ${total.toLocaleString()} 件を置換します。` }),
      h('p', { class: 'dialog-note', text: `プレビューは先頭 ${REPLACE_PREVIEW_FILES} タブ・各タブ先頭 ${REPLACE_PREVIEW_MATCHES} 件まで、変更前後は各 ${REPLACE_PREVIEW_CHARS} 文字までです。省略分を含む全 ${total.toLocaleString()} 件が置換対象です。` }),
      list,
      h('p', { class: 'dialog-note', text: '確定するまで本文は変更しません。置換後も各タブで Ctrl+Z により元に戻せます。' }),
    ]),
    cancelValue: false,
    buttons: [{ label: 'キャンセル', value: false }, { label: '置換する', value: true, primary: true }],
    validate: () => validate(),
  });
}
