import type { DiffTargets } from '../app/diffController';
import { showDialog } from './dialogs';
import { h } from './dom';

export interface DiffDialogOptions {
  /** 比較開始後の各ペインに表示するタブ名（空のペインは null）。ペイン数は 3 以上 */
  paneNames: readonly (string | null)[];
  /** 現在のペイン数がこれより少なく、比較のために拡張する場合の、現在のペイン数 */
  expandedFrom: number | null;
  /** 比較中に対象を変更する場合 */
  changing: boolean;
  initial: DiffTargets;
  /** 選択内容の検証（エラーメッセージを返すと閉じない） */
  validate(targets: DiffTargets): string | null;
}

const ROLES = [
  { key: 'a', label: '比較元（変更前）のペイン', badge: '比較元' },
  { key: 'b', label: '比較先（変更後）のペイン', badge: '比較先' },
  { key: 'result', label: '差分結果を表示するペイン', badge: '結果' },
] as const;

/** 比較元・比較先・結果表示の 3 つのペインを選ぶダイアログ */
export async function showDiffDialog(options: DiffDialogOptions): Promise<DiffTargets | null> {
  const { paneNames } = options;
  const paneLabel = (i: number) => `ペイン ${i + 1} — ${paneNames[i] ?? '空'}`;

  const selects = ROLES.map((role) => {
    const el = h('select', { class: 'input' });
    paneNames.forEach((_, i) => el.append(h('option', { text: paneLabel(i), attrs: { value: String(i) } })));
    el.value = String(options.initial[role.key]);
    return { role, el, field: h('label', { class: 'field' }, [h('span', { class: 'field-label', text: role.label }), el]) };
  });
  const read = (): DiffTargets => ({
    a: Number(selects[0].el.value),
    b: Number(selects[1].el.value),
    result: Number(selects[2].el.value),
  });

  // 何と何を比較し、どこに結果が出るかを、ペインの並びで示す
  const preview = h('div', { class: 'diff-preview', attrs: { 'aria-hidden': 'true' } });
  const summary = h('p', { class: 'diff-summary-note', attrs: { role: 'status' } });
  const notes = h('div', { class: 'diff-notes' });

  const refresh = () => {
    const t = read();
    const roleOf = (i: number) => ROLES.find((r) => t[r.key] === i);
    preview.replaceChildren(
      ...paneNames.map((name, i) => {
        const role = roleOf(i);
        return h('div', { class: `diff-preview-pane${role ? ` role-${role.key}` : ''}` }, [
          h('span', { class: 'diff-preview-no', text: `ペイン ${i + 1}` }),
          h('span', { class: 'diff-preview-name', text: role?.key === 'result' ? '差分結果' : (name ?? '（空）') }),
          h('span', { class: 'diff-preview-role', text: role?.badge ?? '' }),
        ]);
      }),
    );
    const nameOf = (i: number) => paneNames[i];
    const distinct = new Set([t.a, t.b, t.result]).size === 3;
    summary.textContent =
      distinct && nameOf(t.a) && nameOf(t.b)
        ? `ペイン ${t.a + 1} の「${nameOf(t.a)}」（変更前）と、ペイン ${t.b + 1} の「${nameOf(t.b)}」（変更後）を比較し、結果をペイン ${t.result + 1} に表示します。`
        : '比較元・比較先・結果表示に、それぞれ別のペインを選び、比較元・比較先にはタブを表示しているペインを選んでください。';
    const lines: string[] = [];
    if (options.expandedFrom !== null && !options.changing) {
      lines.push(`ペイン数を ${paneNames.length} に拡張して比較します。比較を終了すると、元の配置（${options.expandedFrom} ペイン）に戻ります。`);
    }
    const hidden = nameOf(t.result);
    if (distinct && hidden) {
      lines.push(`ペイン ${t.result + 1} の「${hidden}」は、比較を終了するまで一時的に非表示になります（内容は失われません）。`);
    }
    notes.replaceChildren(...lines.map((text) => h('p', { class: 'dialog-note', text })));
  };
  for (const s of selects) s.el.addEventListener('change', refresh);
  refresh();

  const body = h('div', { class: 'diff-dialog-fields' }, [preview, ...selects.map((s) => s.field), summary, notes]);
  const result = await showDialog<'ok' | null>({
    title: options.changing ? '差分比較の対象を変更' : '差分比較',
    body,
    className: 'dialog-diff',
    cancelValue: null,
    initialFocus: selects[0].el,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '比較する', value: 'ok', primary: true },
    ],
    validate: (v) => (v === 'ok' ? options.validate(read()) : null),
  });
  return result === 'ok' ? read() : null;
}
