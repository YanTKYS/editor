import { h } from './dom';

export interface StatusInfo {
  line: number;
  column: number;
  /** 改行を除く文字数 */
  chars: number;
  lines: number;
  selectedChars: number;
  selectedLines: number;
  selections: number;
  modeLabel: string;
  eol: string;
  mixedEol?: boolean;
  encoding: string;
  tabSize: number;
  indentWithTabs: boolean;
}

export interface StatusBarActions {
  pickMode(anchor: HTMLElement): void;
  pickEol(anchor: HTMLElement): void;
  pickIndent(anchor: HTMLElement): void;
  gotoLine(): void;
  showStorageInfo(): void;
}

/** 下部のステータスバー */
export class StatusBar {
  readonly el: HTMLElement;
  private readonly position: HTMLButtonElement;
  private readonly counts: HTMLElement;
  private readonly selection: HTMLElement;
  private readonly indent: HTMLButtonElement;
  private readonly mode: HTMLButtonElement;
  private readonly eol: HTMLButtonElement;
  private readonly encoding: HTMLElement;
  private readonly save: HTMLButtonElement;

  constructor(actions: StatusBarActions) {
    const item = (cls: string, title: string, onClick?: (el: HTMLButtonElement) => void) => {
      const el = h('button', { class: `status-item ${cls}`, type: 'button', title });
      if (onClick) el.addEventListener('click', () => onClick(el));
      else el.disabled = true;
      return el;
    };
    this.position = item('status-pos', '指定行へ移動 (Ctrl+G)', () => actions.gotoLine());
    this.counts = h('span', { class: 'status-item status-counts', title: '文字数（改行を除く）／行数' });
    this.selection = h('span', { class: 'status-item status-sel', title: '選択中の文字数（改行を除く）' });
    this.save = item('status-save', 'ブラウザ内保存の状態', () => actions.showStorageInfo());
    this.indent = item('status-indent', 'インデント設定を変更', (el) => actions.pickIndent(el));
    this.mode = item('status-mode', '編集モード（構文ハイライト）を変更', (el) => actions.pickMode(el));
    this.eol = item('status-eol', '改行コードを変更（書き出し時に適用）', (el) => actions.pickEol(el));
    this.encoding = h('span', { class: 'status-item status-enc' });
    this.el = h('footer', { class: 'statusbar', attrs: { 'aria-label': 'ステータスバー' } }, [
      this.position,
      this.counts,
      this.selection,
      h('span', { class: 'status-spacer' }),
      this.save,
      this.indent,
      this.mode,
      this.eol,
      this.encoding,
    ]);
  }

  update(info: StatusInfo): void {
    this.position.textContent = `行 ${info.line}, 列 ${info.column}`;
    this.counts.textContent = `${info.chars.toLocaleString()} 文字 / ${info.lines.toLocaleString()} 行`;
    if (info.selectedChars > 0 || info.selections > 1) {
      const multi = info.selections > 1 ? ` [${info.selections} 箇所]` : '';
      this.selection.textContent = `選択: ${info.selectedChars.toLocaleString()} 文字 (${info.selectedLines} 行)${multi}`;
      this.selection.hidden = false;
    } else {
      this.selection.hidden = true;
    }
    this.indent.textContent = info.indentWithTabs ? `タブ: ${info.tabSize}` : `スペース: ${info.tabSize}`;
    this.mode.textContent = info.modeLabel;
    this.eol.textContent = info.mixedEol ? `${info.eol} (混在)` : info.eol;
    this.encoding.textContent = info.encoding;
    this.encoding.title =
      info.encoding === 'UTF-8' || info.encoding === 'UTF-8 (BOM)'
        ? '文字コード'
        : '読み込み時の文字コード（書き出しは UTF-8 で行います）';
  }

  /** アクティブなペインにタブがないときの表示 */
  clear(): void {
    this.position.textContent = '—';
    this.counts.textContent = 'タブなし';
    this.selection.hidden = true;
    this.mode.textContent = '—';
    this.eol.textContent = '—';
    this.encoding.textContent = '';
  }

  setSaveState(text: string, kind: 'ok' | 'pending' | 'error' | 'warning', detail: string): void {
    this.save.textContent = text;
    this.save.dataset.kind = kind;
    this.save.title = `ブラウザ内保存：${detail}\nPC へのファイル書き出しとは別の状態です。\nクリックで保存領域の情報を表示`;
  }
}
