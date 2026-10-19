import { h } from './dom';
import { PopupMenu, type MenuItem } from './popupMenu';

export interface MenuDefinition {
  id: string;
  label: string;
  /** 開くたびに項目を生成する（チェック状態を反映するため） */
  items: () => MenuItem[];
}

/**
 * 上部のメニューバー。キーボードでは ←→ でメニュー間、↑↓ で項目間を移動できる。
 */
export class MenuBar {
  readonly el: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private popup: PopupMenu | null = null;
  private openIndex = -1;
  /** ボタン押下でメニューが閉じた直後の click で再度開かないようにする */
  private lastClosed = { index: -1, time: 0 };

  constructor(private readonly menus: MenuDefinition[]) {
    this.el = h('nav', { class: 'menubar', attrs: { role: 'menubar', 'aria-label': 'メインメニュー' } });
    menus.forEach((menu, i) => {
      const btn = h('button', {
        class: 'menubar-item',
        text: menu.label,
        type: 'button',
        attrs: {
          role: 'menuitem',
          'aria-haspopup': 'menu',
          'aria-expanded': 'false',
          tabindex: i === 0 ? '0' : '-1',
          'data-menu': menu.id,
        },
      });
      btn.addEventListener('click', () => {
        if (this.openIndex === i) this.closeMenu();
        else if (this.lastClosed.index === i && performance.now() - this.lastClosed.time < 400) return;
        else this.open(i, 'first');
      });
      btn.addEventListener('pointerenter', () => {
        if (this.openIndex >= 0 && this.openIndex !== i) this.open(i, 'none');
      });
      btn.addEventListener('keydown', (e) => this.onButtonKey(e, i));
      this.buttons.push(btn);
      this.el.append(btn);
    });
  }

  private onButtonKey(e: KeyboardEvent, i: number): void {
    const n = this.buttons.length;
    switch (e.key) {
      case 'ArrowRight':
        this.focusButton((i + 1) % n);
        break;
      case 'ArrowLeft':
        this.focusButton((i - 1 + n) % n);
        break;
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        this.open(i, 'first');
        break;
      case 'ArrowUp':
        this.open(i, 'last');
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private focusButton(i: number): void {
    this.buttons.forEach((b, j) => b.setAttribute('tabindex', j === i ? '0' : '-1'));
    this.buttons[i].focus();
  }

  /** メニューを開く（id 指定） */
  openById(id: string): void {
    const i = this.menus.findIndex((m) => m.id === id);
    if (i >= 0) this.open(i, 'first');
  }

  private open(i: number, focus: 'first' | 'last' | 'none'): void {
    this.popup?.close('cancel');
    const btn = this.buttons[i];
    this.openIndex = i;
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('open');
    this.buttons.forEach((b, j) => b.setAttribute('tabindex', j === i ? '0' : '-1'));
    const popup = new PopupMenu(this.menus[i].items(), {
      horizontalNavigation: true,
      label: this.menus[i].label,
      focus,
      onClose: (reason, direction) => {
        btn.setAttribute('aria-expanded', 'false');
        btn.classList.remove('open');
        if (this.popup === popup) {
          this.popup = null;
          this.openIndex = -1;
        }
        if (reason === 'cancel') this.lastClosed = { index: i, time: performance.now() };
        const n = this.buttons.length;
        if (reason === 'navigate' && direction) {
          this.open((i + direction + n) % n, 'first');
        } else if (reason === 'cancel' && this.el.contains(document.activeElement) === false) {
          if (document.activeElement === document.body || !document.activeElement) btn.focus();
        }
      },
    });
    this.popup = popup;
    popup.showAt(btn);
  }

  closeMenu(): void {
    this.popup?.close('cancel');
  }
}
