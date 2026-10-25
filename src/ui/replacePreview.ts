import {
  REPLACE_PREVIEW_CHARS,
  REPLACE_PREVIEW_FILES,
  REPLACE_PREVIEW_MATCHES,
  type ReplacementExample,
} from '../core/search';
import { showDialog } from './dialogs';
import { h } from './dom';

export interface ReplacementFilePreview {
  id: string;
  name: string;
  tabNumber: number;
  count: number;
}

/** 選択はタブIDで保持し、プレビューのDOMと取得する例は1ページ分に制限する。 */
export async function showReplacePreview(
  files: ReplacementFilePreview[],
  getExamples: (id: string) => ReplacementExample[],
  validate: () => string | null,
): Promise<string[] | null> {
  const selected = new Set(files.map(file => file.id));
  const summary = h('p', { class: 'replace-preview-summary', attrs: { role: 'status' } });
  const limits = h('p', { class: 'dialog-note' });
  const empty = h('p', { class: 'dialog-note', text: '置換対象のタブを1つ以上選択してください。' });
  const list = h('div', { class: 'replace-preview-list' });
  const body = h('div', {}, [summary]);
  let page = 0;
  const pages = Math.max(1, Math.ceil(files.length / REPLACE_PREVIEW_FILES));
  let visible: { checkbox: HTMLInputElement; sync(): void }[] = [];

  const updateSummary = () => {
    const chosen = files.filter(file => selected.has(file.id));
    const total = chosen.reduce((sum, file) => sum + file.count, 0);
    summary.textContent = `${chosen.length} 個のタブで合計 ${total.toLocaleString()} 件を置換します。（対象候補 ${files.length} タブ）`;
    limits.textContent = `プレビューは1ページ ${REPLACE_PREVIEW_FILES} タブ・各タブ先頭 ${REPLACE_PREVIEW_MATCHES} 件まで、変更前後は各 ${REPLACE_PREVIEW_CHARS} 文字までです。別ページや省略分を含む全 ${total.toLocaleString()} 件が置換対象です（選択したタブのみ）。`;
    empty.hidden = selected.size > 0;
  };
  const notifySelection = () => {
    updateSummary();
    // 一括選択のボタン操作でも、共通ダイアログの実行ボタンを更新する。
    body.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const selectAll = (checked: boolean) => {
    selected.clear();
    if (checked) files.forEach(file => selected.add(file.id));
    visible.forEach(item => { item.checkbox.checked = checked; item.sync(); });
    notifySelection();
  };
  const button = (text: string, action: () => void) => h('button', {
    class: 'btn btn-small', type: 'button', text, on: { click: action },
  });
  const pageLabel = h('span', { class: 'replace-preview-page', attrs: { role: 'status' } });
  const previous = button('前のページ', () => { page--; renderPage(); });
  const next = button('次のページ', () => { page++; renderPage(); });
  previous.hidden = next.hidden = pageLabel.hidden = pages === 1;
  const controls = h('div', { class: 'replace-preview-controls' }, [
    button('全タブを選択', () => selectAll(true)),
    button('全タブを解除', () => selectAll(false)),
    previous, pageLabel, next,
  ]);

  function renderPage(): void {
    list.replaceChildren();
    visible = [];
    previous.disabled = page === 0;
    next.disabled = page + 1 >= pages;
    pageLabel.textContent = `${page + 1} / ${pages} ページ`;
    for (const file of files.slice(page * REPLACE_PREVIEW_FILES, (page + 1) * REPLACE_PREVIEW_FILES)) {
      const checkbox = h('input', { type: 'checkbox' });
      checkbox.checked = selected.has(file.id);
      const details = h('div', { class: 'replace-preview-details' });
      const group = h('section', { class: 'replace-preview-file' }, [
        h('h3', {}, [h('label', {}, [checkbox, `タブ ${file.tabNumber} — ${file.name}（${file.count.toLocaleString()} 件）`])]),
        details,
      ]);
      let loaded = false;
      const sync = () => {
        details.hidden = !checkbox.checked;
        if (!checkbox.checked || loaded) return;
        loaded = true;
        const examples = getExamples(file.id);
        for (const example of examples) {
          const pair = (label: string, value: string) => h('div', {}, [
            h('span', { class: 'replace-preview-label', text: label }),
            h('pre', { text: value || '（空文字）' }),
          ]);
          details.append(h('div', { class: 'replace-preview-example' }, [
            h('p', { text: `行 ${example.line}, 列 ${example.column}（置換前）` }),
            h('pre', { class: 'replace-preview-context', text: `行の抜粋：${example.context}` }),
            h('div', { class: 'replace-preview-pair' }, [pair('変更前', example.before), pair('変更後', example.after)]),
          ]));
        }
        if (file.count > examples.length) {
          details.append(h('p', { class: 'dialog-note', text: `ほか ${file.count - examples.length} 件は表示を省略しています。` }));
        }
      };
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(file.id);
        else selected.delete(file.id);
        sync();
        updateSummary();
      });
      visible.push({ checkbox, sync });
      sync();
      list.append(group);
    }
  }
  updateSummary();
  renderPage();
  body.append(limits, controls, empty, list,
    h('p', { class: 'dialog-note', text: '確定するまで本文は変更しません。置換後も各タブで Ctrl+Z により元に戻せます。' }));
  const ok = await showDialog<boolean>({
    title: 'すべてのタブで置換',
    className: 'dialog-replace-preview',
    body,
    cancelValue: false,
    buttons: [
      { label: 'キャンセル', value: false },
      { label: '置換する', value: true, primary: true, disabled: () => selected.size === 0 },
    ],
    validate: () => selected.size ? validate() : '置換対象のタブを1つ以上選択してください。',
  });
  return ok ? [...selected] : null;
}
