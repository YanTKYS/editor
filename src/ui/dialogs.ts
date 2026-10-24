import { h } from './dom';

export interface DialogButton<T> {
  label: string;
  value: T;
  /** 主要ボタン（Enter で実行） */
  primary?: boolean;
  /** 危険な操作（赤系の表示） */
  danger?: boolean;
  /** 選択内容に応じて無効化する（フォームの change 時にも評価） */
  disabled?: () => boolean;
}

export interface DialogOptions<T> {
  title: string;
  message?: string | Node;
  body?: Node;
  buttons: DialogButton<T>[];
  /** Esc・閉じる操作時の値 */
  cancelValue: T;
  /** 最初にフォーカスする要素 */
  initialFocus?: HTMLElement;
  /** 送信前の検証（エラーメッセージを返すと閉じない） */
  validate?: (value: T) => string | null;
  className?: string;
}

let openCount = 0;

/** モーダルダイアログが開いているか */
export function isDialogOpen(): boolean {
  return openCount > 0;
}

/**
 * <dialog> 要素によるモーダルダイアログを表示する。
 * 閉じた後は直前にフォーカスしていた要素へフォーカスを戻す。
 */
export function showDialog<T>(options: DialogOptions<T>): Promise<T> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const titleId = `dlg-title-${Math.random().toString(36).slice(2, 8)}`;
    const error = h('p', { class: 'dialog-error', attrs: { role: 'alert' } });
    error.hidden = true;
    const dialog = h('dialog', {
      class: `dialog ${options.className ?? ''}`.trim(),
      attrs: { 'aria-labelledby': titleId },
    });
    const form = h('form', { attrs: { method: 'dialog' } });
    form.append(h('h2', { class: 'dialog-title', text: options.title, attrs: { id: titleId } }));
    if (options.message !== undefined) {
      const msg = h('div', { class: 'dialog-message' });
      if (typeof options.message === 'string') {
        for (const line of options.message.split('\n')) msg.append(h('p', { text: line }));
      } else {
        msg.append(options.message);
      }
      form.append(msg);
    }
    if (options.body) form.append(h('div', { class: 'dialog-body' }, [options.body]));
    form.append(error);
    const footer = h('div', { class: 'dialog-buttons' });
    let primaryButton: HTMLButtonElement | null = null;
    options.buttons.forEach((b, i) => {
      const btn = h('button', {
        class: `btn${b.primary ? ' btn-primary' : ''}${b.danger ? ' btn-danger' : ''}`,
        text: b.label,
        type: b.primary ? 'submit' : 'button',
        dataset: { index: String(i) },
      });
      if (b.disabled) {
        btn.disabled = b.disabled();
        form.addEventListener('change', () => { btn.disabled = b.disabled!(); });
      }
      if (b.primary) primaryButton = btn;
      if (!b.primary) btn.addEventListener('click', () => finish(b.value));
      footer.append(btn);
    });
    form.append(footer);
    dialog.append(form);

    let done = false;
    const finish = (value: T) => {
      if (done) return;
      if (options.validate && value !== options.cancelValue) {
        const msg = options.validate(value);
        if (msg) {
          error.textContent = msg;
          error.hidden = false;
          return;
        }
      }
      done = true;
      openCount--;
      dialog.close();
      dialog.remove();
      previousFocus?.focus?.();
      resolve(value);
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const primary = options.buttons.find((b) => b.primary);
      if (primary && !primary.disabled?.()) finish(primary.value);
    });
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(options.cancelValue);
    });
    // 背景（::backdrop）クリックでは閉じない（誤操作防止）

    document.body.append(dialog);
    openCount++;
    dialog.showModal();
    const focusTarget = options.initialFocus ?? primaryButton ?? footer.querySelector('button');
    focusTarget?.focus();
  });
}

/** 確認ダイアログ。OK なら true */
export async function confirmDialog(
  title: string,
  message: string,
  okLabel = 'OK',
  options: { danger?: boolean; cancelLabel?: string } = {},
): Promise<boolean> {
  return showDialog<boolean>({
    title,
    message,
    cancelValue: false,
    buttons: [
      { label: options.cancelLabel ?? 'キャンセル', value: false },
      { label: okLabel, value: true, primary: true, danger: options.danger },
    ],
  });
}

export async function alertDialog(title: string, message: string | Node): Promise<void> {
  await showDialog<null>({
    title,
    message,
    cancelValue: null,
    buttons: [{ label: '閉じる', value: null, primary: true }],
  });
}

/** 文字列入力ダイアログ。キャンセル時は null */
export async function promptDialog(
  title: string,
  label: string,
  initial = '',
  options: {
    okLabel?: string;
    validate?: (value: string) => string | null;
    selectBaseName?: boolean;
    inputMode?: 'text' | 'numeric';
    placeholder?: string;
  } = {},
): Promise<string | null> {
  const input = h('input', {
    class: 'input',
    type: 'text',
    attrs: {
      autocomplete: 'off',
      spellcheck: 'false',
      inputmode: options.inputMode,
      placeholder: options.placeholder,
    },
  });
  input.value = initial;
  const body = h('label', { class: 'field' }, [h('span', { class: 'field-label', text: label }), input]);
  const SUBMIT = '\u0000submit';
  const result = showDialog<string | null>({
    title,
    body,
    cancelValue: null,
    initialFocus: input,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: options.okLabel ?? 'OK', value: SUBMIT, primary: true },
    ],
    validate: (v) => (v === SUBMIT && options.validate ? options.validate(input.value) : null),
  });
  // フォーカス後に選択範囲を設定（拡張子の前までを選択）
  queueMicrotask(() => {
    const dot = initial.lastIndexOf('.');
    if (options.selectBaseName && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
  const value = await result;
  return value === SUBMIT ? input.value : null;
}
