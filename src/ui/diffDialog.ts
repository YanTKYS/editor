import type { DiffTargets } from '../app/diffController';
import { showDialog } from './dialogs';
import { h } from './dom';

export interface DiffDialogOptions {
  tabs: readonly { id: string; name: string }[];
  /** 現在の分割数。3 以上のときだけ、比較するペインを選べる */
  paneCount: number;
  initial: DiffTargets;
  /** 選択内容の検証（エラーメッセージを返すと閉じない） */
  validate(targets: DiffTargets): string | null;
}

/** 比較するタブ（と、3 分割以上ではペイン）を選ぶ小さなダイアログ */
export async function showDiffDialog(options: DiffDialogOptions): Promise<DiffTargets | null> {
  const select = (label: string, choices: { value: string; label: string }[], value: string) => {
    const el = h('select', { class: 'input' });
    for (const c of choices) el.append(h('option', { text: c.label, attrs: { value: c.value } }));
    el.value = value;
    return { el, field: h('label', { class: 'field' }, [h('span', { class: 'field-label', text: label }), el]) };
  };
  const tabChoices = options.tabs.map((t) => ({ value: t.id, label: t.name }));
  const a = select('比較元（左）のタブ', tabChoices, options.initial.a);
  const b = select('比較先（右）のタブ', tabChoices, options.initial.b);
  const fields: HTMLElement[] = [a.field, b.field];

  const paneChoices = Array.from({ length: Math.max(options.paneCount, 2) }, (_, i) => ({
    value: String(i),
    label: `ペイン ${i + 1}`,
  }));
  const paneA = select('比較元を表示するペイン', paneChoices, String(options.initial.paneA));
  const paneB = select('比較先を表示するペイン', paneChoices, String(options.initial.paneB));
  if (options.paneCount >= 3) fields.push(paneA.field, paneB.field);

  const note =
    options.paneCount >= 3
      ? '選んだ 2 つのペインに表示して比較します（他のペインはそのままです）。'
      : options.paneCount === 2
        ? '左右のペインで比較します。'
        : '2 分割にして比較します。比較を終了すると 1 画面に戻ります。';
  const body = h('div', { class: 'diff-dialog-fields' }, [...fields, h('p', { class: 'dialog-note', text: note })]);

  const read = (): DiffTargets => ({
    a: a.el.value,
    b: b.el.value,
    paneA: Number(paneA.el.value),
    paneB: Number(paneB.el.value),
  });
  const result = await showDialog<'ok' | null>({
    title: '差分比較',
    body,
    cancelValue: null,
    initialFocus: b.el,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '比較する', value: 'ok', primary: true },
    ],
    validate: (v) => (v === 'ok' ? options.validate(read()) : null),
  });
  return result === 'ok' ? read() : null;
}
