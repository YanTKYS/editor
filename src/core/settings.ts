import {
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  TAB_SIZE_MAX,
  TAB_SIZE_MIN,
  type Settings,
} from './types';

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 外部（保存データ・バックアップ）から読み込んだ設定値を検証し、
 * 不正・欠落した項目は既定値で補完する。
 */
export function normalizeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ratio =
    typeof src.previewRatio === 'number' && Number.isFinite(src.previewRatio)
      ? Math.min(0.85, Math.max(0.15, src.previewRatio))
      : base.previewRatio;
  return {
    theme: src.theme === 'dark' || src.theme === 'light' ? src.theme : base.theme,
    fontSize: clampInt(src.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, base.fontSize),
    tabSize: clampInt(src.tabSize, TAB_SIZE_MIN, TAB_SIZE_MAX, base.tabSize),
    indentWithTabs: bool(src.indentWithTabs, base.indentWithTabs),
    wordWrap: bool(src.wordWrap, base.wordWrap),
    lineNumbers: bool(src.lineNumbers, base.lineNumbers),
    showWhitespace: bool(src.showWhitespace, base.showWhitespace),
    showLineEndings: bool(src.showLineEndings, base.showLineEndings),
    markdownPreview: bool(src.markdownPreview, base.markdownPreview),
    previewRatio: ratio,
  };
}

/** 初回起動時の設定（OS のダークモード設定に合わせる） */
export function initialSettings(): Settings {
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return { ...DEFAULT_SETTINGS, theme: prefersDark ? 'dark' : 'light' };
}
