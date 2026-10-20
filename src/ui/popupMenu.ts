import { h } from './dom';

export type MenuItem =
  | {
      label: string;
      action: () => void;
      shortcut?: string;
      checked?: boolean;
      disabled?: boolean;
      /** 補足説明（ツールチップ） */
      hint?: string;
    }
  | { separator: true }
  | { heading: string };

export interface PopupOptions {
  /** 閉じたときに呼ばれる（reason: 'select' | 'cancel' | 'navigate'） */
  onClose?: (reason: 'select' | 'cancel' | 'navigate', direction?: -1 | 1) => void;
  /** 左右キーでメニューバーを移動するために使う */
  horizontalNavigation?: boolean;
  label?: string;
  /** 開いた直後にフォーカスする項目（'first' | 'last' | 'none'） */
  focus?: 'first' | 'last' | 'none';
}

let current: PopupMenu | null = null;

/** 現在開いているポップアップを閉じる */
export function closePopup(): void {
  current?.close('cancel');
}

/** ドロップダウン・コンテキストメニュー共通の部品 */
export class PopupMenu {
  readonly el: HTMLElement;
  private items: HTMLElement[] = [];
  private closed = false;
  private readonly onDocPointer = (e: PointerEvent) => {
    if (!this.el.contains(e.target as Node)) this.close('cancel');
  };
  private readonly onWindowBlur = () => this.close('cancel');

  constructor(
    items: MenuItem[],
    private readonly options: PopupOptions = {},
  ) {
    current?.close('cancel');
    current = this;
    this.el = h('div', {
      class: 'popup-menu',
      attrs: { role: 'menu', 'aria-label': options.label, tabindex: '-1' },
    });
    for (const item of items) {
      if ('separator' in item) {
        this.el.append(h('div', { class: 'menu-separator', attrs: { role: 'separator' } }));
      } else if ('heading' in item) {
        this.el.append(h('div', { class: 'menu-heading', text: item.heading }));
      } else {
        const role = item.checked === undefined ? 'menuitem' : 'menuitemcheckbox';
        const el = h(
          'div',
          {
            class: `menu-item${item.disabled ? ' disabled' : ''}`,
            title: item.hint,
            attrs: {
              role,
              tabindex: '-1',
              'aria-disabled': item.disabled ? 'true' : null,
              'aria-checked': item.checked === undefined ? null : String(item.checked),
            },
          },
          [
            h('span', { class: 'menu-check', text: item.checked ? '✓' : '' }),
            h('span', { class: 'menu-label', text: item.label }),
            h('span', { class: 'menu-shortcut', text: item.shortcut ?? '' }),
          ],
        );
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (item.disabled) return;
          this.close('select');
          item.action();
        });
        el.addEventListener('pointermove', () => el.focus({ preventScroll: true }));
        this.items.push(el);
        this.el.append(el);
      }
    }
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    document.body.append(this.el);
    setTimeout(() => {
      if (this.closed) return;
      document.addEventListener('pointerdown', this.onDocPointer, true);
      window.addEventListener('blur', this.onWindowBlur);
    });
  }

  /** 要素の下（またはクライアント座標）に表示する */
  showAt(anchor: HTMLElement | { x: number; y: number }, placement: 'below' | 'above' = 'below'): this {
    const menu = this.el;
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let x: number;
    let y: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      x = r.left;
      y = placement === 'below' ? r.bottom : r.top - mh;
      if (placement === 'below' && y + mh > vh && r.top - mh >= 0) y = r.top - mh;
      if (placement === 'above' && y < 0) y = r.bottom;
    } else {
      x = anchor.x;
      y = anchor.y;
      if (y + mh > vh) y = Math.max(0, y - mh);
    }
    x = Math.max(0, Math.min(x, vw - mw));
    y = Math.max(0, Math.min(y, vh - mh));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.visibility = '';
    const focus = this.options.focus ?? 'first';
    if (focus === 'none') menu.focus({ preventScroll: true });
    else this.focusIndex(focus === 'first' ? 0 : this.items.length - 1, focus === 'first' ? 1 : -1);
    return this;
  }

  private focusIndex(index: number, dir: 1 | -1): void {
    const n = this.items.length;
    if (!n) return;
    for (let i = 0; i < n; i++) {
      const idx = (((index + i * dir) % n) + n) % n;
      const el = this.items[idx];
      if (!el.classList.contains('disabled')) {
        el.focus({ preventScroll: false });
        return;
      }
    }
  }

  private onKey(e: KeyboardEvent): void {
    const idx = this.items.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case 'ArrowDown':
        this.focusIndex(idx + 1, 1);
        break;
      case 'ArrowUp':
        this.focusIndex(idx < 0 ? this.items.length - 1 : idx - 1, -1);
        break;
      case 'Home':
        this.focusIndex(0, 1);
        break;
      case 'End':
        this.focusIndex(this.items.length - 1, -1);
        break;
      case 'Enter':
      case ' ':
        if (idx >= 0) this.items[idx].click();
        break;
      case 'Escape':
        this.close('cancel');
        break;
      case 'Tab':
        this.close('cancel');
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!this.options.horizontalNavigation) return;
        this.close('navigate', e.key === 'ArrowLeft' ? -1 : 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  close(reason: 'select' | 'cancel' | 'navigate', direction?: -1 | 1): void {
    if (this.closed) return;
    this.closed = true;
    if (current === this) current = null;
    document.removeEventListener('pointerdown', this.onDocPointer, true);
    window.removeEventListener('blur', this.onWindowBlur);
    this.el.remove();
    this.options.onClose?.(reason, direction);
  }
}
