import { isLineEnding, normalizeLineEndings } from './lineEndings';
import { isEditorMode } from './modes';
import { isPaneCount } from './paneLayout';
import { normalizeSettings } from './settings';
import type { EditorMode, LineEnding, Settings, SourceEncoding } from './types';

export const BACKUP_FORMAT = 'web-text-editor-backup';
export const BACKUP_VERSION = 1;

/** 1 ファイルあたりの上限（誤って巨大な JSON を読み込んだ際の保護） */
export const BACKUP_MAX_TABS = 500;

export interface BackupTab {
  name: string;
  content: string;
  mode: EditorMode;
  eol: LineEnding;
  encoding: SourceEncoding;
  bom: boolean;
}

/**
 * 画面分割の状態（v0.2.0 で追加した任意項目）。
 * タブ ID は復元時に振り直すため、タブの位置（tabs 配列の添字）で表す。
 * 形式 v1 のまま追加しているため、v0.1.0 でもこの項目を無視して読み込める。
 */
export interface BackupLayout {
  count: number;
  panes: (number | null)[];
  active: number;
}

export interface BackupData {
  format: typeof BACKUP_FORMAT;
  version: number;
  appVersion: string;
  exportedAt: string;
  activeIndex: number;
  settings: Settings;
  tabs: BackupTab[];
  layout?: BackupLayout;
}

export function createBackup(
  tabs: BackupTab[],
  activeIndex: number,
  settings: Settings,
  appVersion: string,
  layout?: BackupLayout,
): BackupData {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    activeIndex,
    settings,
    tabs,
    ...(layout ? { layout } : {}),
  };
}

export class BackupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupValidationError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * バックアップ JSON 文字列を検証して BackupData に変換する。
 * 不正な場合は理由を含む BackupValidationError を送出する。
 */
export function parseBackup(json: string): BackupData {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new BackupValidationError('JSON として解析できません。');
  }
  if (!isObject(raw)) throw new BackupValidationError('バックアップの形式が正しくありません。');
  if (raw.format !== BACKUP_FORMAT) {
    throw new BackupValidationError('このエディタのバックアップファイルではありません。');
  }
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version)) {
    throw new BackupValidationError('バックアップのバージョン情報がありません。');
  }
  if (raw.version > BACKUP_VERSION) {
    throw new BackupValidationError(
      `新しいバージョンのバックアップ（形式 v${raw.version}）のため読み込めません。`,
    );
  }
  if (!Array.isArray(raw.tabs)) throw new BackupValidationError('タブ情報がありません。');
  if (raw.tabs.length === 0) throw new BackupValidationError('タブが 1 つも含まれていません。');
  if (raw.tabs.length > BACKUP_MAX_TABS) {
    throw new BackupValidationError(`タブ数が多すぎます（上限 ${BACKUP_MAX_TABS}）。`);
  }
  const tabs: BackupTab[] = raw.tabs.map((t, i) => {
    const label = `${i + 1} 番目のタブ`;
    if (!isObject(t)) throw new BackupValidationError(`${label}の形式が正しくありません。`);
    if (typeof t.name !== 'string' || !t.name.trim()) {
      throw new BackupValidationError(`${label}の名前が正しくありません。`);
    }
    if (typeof t.content !== 'string') {
      throw new BackupValidationError(`${label}（${t.name}）の本文が正しくありません。`);
    }
    return {
      name: t.name.trim().slice(0, 255),
      content: normalizeLineEndings(t.content),
      mode: isEditorMode(t.mode) ? t.mode : 'plaintext',
      eol: isLineEnding(t.eol) ? t.eol : 'LF',
      encoding: t.encoding === 'Shift_JIS' ? 'Shift_JIS' : 'UTF-8',
      bom: t.bom === true,
    };
  });
  const activeIndex =
    typeof raw.activeIndex === 'number' &&
    Number.isInteger(raw.activeIndex) &&
    raw.activeIndex >= 0 &&
    raw.activeIndex < tabs.length
      ? raw.activeIndex
      : 0;
  return {
    format: BACKUP_FORMAT,
    version: raw.version,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    activeIndex,
    settings: normalizeSettings(raw.settings),
    tabs,
    layout: parseLayout(raw.layout, tabs.length),
  };
}

/** 画面分割の状態を検証する（不正な場合は無視して 1 画面として扱う） */
function parseLayout(raw: unknown, tabCount: number): BackupLayout | undefined {
  if (!isObject(raw) || !isPaneCount(raw.count) || !Array.isArray(raw.panes)) return undefined;
  const count = raw.count;
  const seen = new Set<number>();
  const panes: (number | null)[] = [];
  for (let i = 0; i < count; i++) {
    const v: unknown = raw.panes[i];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < tabCount && !seen.has(v)) {
      seen.add(v);
      panes.push(v);
    } else {
      panes.push(null);
    }
  }
  const active =
    typeof raw.active === 'number' && Number.isInteger(raw.active) && raw.active >= 0 && raw.active < count
      ? raw.active
      : 0;
  return { count, panes, active };
}
