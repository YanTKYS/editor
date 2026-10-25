import type { BatchExportFile } from '../files/batchExport';
import { showDialog } from './dialogs';
import { h } from './dom';

/** 候補は20件ずつ表示し、別ページの選択もタブIDで維持する。 */
export async function selectBatchExport(
  files: BatchExportFile[],
  validate: (ids: string[]) => string | null,
): Promise<string[] | null> {
  const selected = new Set(files.map(file => file.id));
  const summary = h('p', { attrs: { role: 'status' } });
  const list = h('div', { class: 'batch-export-list' });
  const body = h('div', {}, [
    h('p', { text: '選択したタブを通常のテキストファイルとして1つの ZIP にまとめます。全タブ・設定を復元するバックアップ JSON とは別の機能です。' }),
    h('p', { class: 'dialog-note', text: '全ファイルを UTF-8 で書き出し、各タブの改行コード・BOM を反映します。同名や使用できない名前は調整し、下記の ZIP 内の名前で保存します。' }),
    h('p', { class: 'dialog-note', text: 'ZIP の保存後、次の画面で保存を確認すると書き出し済みにできます。保存を中止した場合は未書き出しのまま閉じてください。' }),
    summary,
  ]);
  let page = 0;
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil(files.length / pageSize));
  const label = h('span', { attrs: { role: 'status' } });
  const button = (text: string, action: () => void) => h('button', {
    class: 'btn btn-small', type: 'button', text, on: { click: action },
  });
  const refreshSummary = () => {
    summary.textContent = `${selected.size} / ${files.length} タブを選択中${selected.size ? '' : ' — 対象を1つ以上選択してください。'}`;
  };
  const all = (checked: boolean) => {
    selected.clear();
    if (checked) files.forEach(file => selected.add(file.id));
    render();
    body.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const previous = button('前のページ', () => { page--; render(); });
  const next = button('次のページ', () => { page++; render(); });
  previous.hidden = next.hidden = label.hidden = pages === 1;
  const controls = h('div', { class: 'batch-export-controls' }, [
    button('全タブを選択', () => all(true)), button('全タブを解除', () => all(false)), previous, label, next,
  ]);
  function render(): void {
    refreshSummary();
    previous.disabled = page === 0;
    next.disabled = page + 1 >= pages;
    label.textContent = `${page + 1} / ${pages} ページ`;
    list.replaceChildren(...files.slice(page * pageSize, (page + 1) * pageSize).map(file => {
      const check = h('input', { type: 'checkbox' });
      check.checked = selected.has(file.id);
      check.addEventListener('change', () => {
        if (check.checked) selected.add(file.id);
        else selected.delete(file.id);
        refreshSummary();
      });
      return h('label', { class: 'batch-export-row' }, [check, h('span', {}, [
        h('strong', { text: `タブ ${file.tabNumber} — ${file.name}` }),
        h('span', { text: `ZIP 内：${file.fileName}（UTF-8${file.bom ? ' BOM 付き' : ''}・${file.eol}）` }),
      ])]);
    }));
  }
  render();
  body.append(controls, list);
  const ok = await showDialog<boolean>({
    title: '未書き出しタブをまとめて書き出し', body, className: 'dialog-batch-export', cancelValue: false,
    buttons: [
      { label: 'キャンセル', value: false },
      { label: 'ZIP をダウンロード', value: true, primary: true, disabled: () => !selected.size },
    ],
    validate: () => selected.size ? validate([...selected]) : '対象を1つ以上選択してください。',
  });
  return ok ? [...selected] : null;
}
