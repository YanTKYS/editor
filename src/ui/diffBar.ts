import { h } from './dom';

export interface DiffBarActions {
  previous(): void;
  next(): void;
  change(): void;
  end(): void;
}

export interface DiffBarInfo {
  /** 例: 「ペイン 1: original.txt」 */
  aName: string;
  bName: string;
  resultName: string;
  added: number;
  deleted: number;
  changed: number;
  total: number;
  /** 選択中の差分（0 始まり。未選択は -1） */
  current: number;
  precise: boolean;
}

/** 差分比較中だけ表示する、編集領域の上の細い操作バー */
export class DiffBar {
  readonly el: HTMLElement;
  private readonly names = h('span', { class: 'diff-names' });
  private readonly summary = h('span', { class: 'diff-summary', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly position = h('span', { class: 'diff-position' });
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;

  constructor(actions: DiffBarActions) {
    const button = (text: string, title: string, onClick: () => void, cls = '') =>
      h('button', { class: `diff-button ${cls}`.trim(), text, type: 'button', title, on: { click: onClick } });
    this.prev = button('▲ 前の差分', '前の差分 (Shift+F8)', () => actions.previous());
    this.next = button('▼ 次の差分', '次の差分 (F8)', () => actions.next());
    this.el = h(
      'div',
      { class: 'diff-bar', attrs: { role: 'toolbar', 'aria-label': '差分比較' } },
      [
        h('span', { class: 'diff-label', text: '差分比較' }),
        this.names,
        this.summary,
        this.position,
        h('span', { class: 'diff-spacer' }),
        this.prev,
        this.next,
        button('比較対象…', '比較するタブを変更する', () => actions.change()),
        button('比較終了', '差分比較を終了して通常の編集に戻る', () => actions.end(), 'diff-end'),
      ],
    );
    this.el.hidden = true;
  }

  update(info: DiffBarInfo | null): void {
    this.el.hidden = !info;
    if (!info) return;
    this.names.textContent = `${info.aName}  ⇄  ${info.bName}`;
    this.names.title = `比較元（変更前）: ${info.aName}\n比較先（変更後）: ${info.bName}\n結果: ${info.resultName}`;
    this.summary.textContent =
      info.total === 0
        ? '差分はありません（内容が同じです）'
        : `差分 ${info.total} 件（追加 ${info.added}・削除 ${info.deleted}・変更 ${info.changed}）${info.precise ? '' : ' ※大きな差分のため簡易比較'}`;
    this.position.textContent = info.total > 0 && info.current >= 0 ? `${info.current + 1} / ${info.total}` : '';
    this.prev.disabled = this.next.disabled = info.total === 0;
  }
}
