import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: false, async: false });

/** プレビューで許可しない要素（スクリプト実行・画面の乗っ取り・外部送信につながるもの） */
const FORBID_TAGS = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'template',
];

/** style 属性はオーバーレイ等による UI 偽装を防ぐため除去する */
const FORBID_ATTR = ['style', 'srcset', 'action', 'formaction', 'ping'];

const SAFE_URL = /^(?:https?:|mailto:|#|\.{0,2}\/|[^:/?#]*(?:[/?#]|$))/i;

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;
    for (const attr of ['href', 'src']) {
      const value = node.getAttribute(attr);
      if (value === null) continue;
      const trimmed = value.trim();
      const allowData = attr === 'src' && /^data:image\/(?:png|gif|jpe?g|webp|bmp);/i.test(trimmed);
      if (!allowData && !SAFE_URL.test(trimmed)) node.removeAttribute(attr);
    }
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/**
 * Markdown を安全な HTML 文字列に変換する。
 * marked で HTML 化した後、DOMPurify でスクリプト・イベント属性・危険な URL を除去する。
 */
export function renderMarkdown(source: string): string {
  installHooks();
  const html = marked.parse(source) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
