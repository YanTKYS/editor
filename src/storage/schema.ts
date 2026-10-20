import { isLineEnding } from '../core/lineEndings';
import { isEditorMode } from '../core/modes';
import { normalizeSettings } from '../core/settings';
import { PaneLayout, type PaneLayoutState } from '../core/paneLayout';
import type { PersistedTabMeta, SelectionJSON, Settings } from '../core/types';

/** ブラウザ内保存データのスキーマバージョン。形式を変える場合は増やし、migrate に変換処理を追加する */
export const SCHEMA_VERSION = 2;
export const APP_ID = 'web-text-editor';

/** タブ構成・設定など本文以外の保存データ */
export interface PersistedMeta {
  schemaVersion: number;
  app: string;
  /** 書き込みごとに増える番号（他のブラウザタブとの競合検知に使用） */
  revision: number;
  /** 最後に書き込んだアプリインスタンスの ID */
  writerId: string;
  savedAt: number;
  activeTabId: string | null;
  tabs: PersistedTabMeta[];
  settings: Settings;
  /** 画面分割の状態（v2 で追加） */
  layout: PaneLayoutState;
}

export type SchemaErrorKind = 'corrupt' | 'newer';

export class SchemaError extends Error {
  constructor(
    public readonly kind: SchemaErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SchemaError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSelection(raw: unknown): SelectionJSON | undefined {
  if (!isObject(raw) || !Array.isArray(raw.ranges) || typeof raw.main !== 'number') return undefined;
  const ranges = raw.ranges
    .filter(
      (r): r is { anchor: number; head: number } =>
        isObject(r) && Number.isInteger(r.anchor) && Number.isInteger(r.head),
    )
    .map((r) => ({ anchor: Math.max(0, r.anchor), head: Math.max(0, r.head) }));
  if (!ranges.length) return undefined;
  return { ranges, main: Math.min(Math.max(0, Math.trunc(raw.main)), ranges.length - 1) };
}

function parseTab(raw: unknown): PersistedTabMeta | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const now = Date.now();
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : '無題',
    mode: isEditorMode(raw.mode) ? raw.mode : 'plaintext',
    eol: isLineEnding(raw.eol) ? raw.eol : 'LF',
    encoding: raw.encoding === 'Shift_JIS' ? 'Shift_JIS' : 'UTF-8',
    bom: raw.bom === true,
    modifiedSinceFile: raw.modifiedSinceFile === true,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    selection: parseSelection(raw.selection),
    scrollPos: typeof raw.scrollPos === 'number' && raw.scrollPos >= 0 ? raw.scrollPos : undefined,
  };
}

/**
 * v1 → v2: 画面分割の状態（layout）を追加する。
 * v1 は 1 画面のみのため、アクティブタブを 1 画面に表示した状態とする。
 */
function migrateV1toV2(raw: Record<string, unknown>): Record<string, unknown> {
  const activeTabId = typeof raw.activeTabId === 'string' ? raw.activeTabId : null;
  return { ...raw, schemaVersion: 2, layout: { count: 1, tabs: [activeTabId], active: 0 } };
}

/**
 * 旧バージョンの保存データを現行スキーマへ変換する。
 * 形式を変える場合は SCHEMA_VERSION を増やし、ここに変換処理を追加する。
 */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const version = raw.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new SchemaError('corrupt', '保存データのバージョン情報が不正です。');
  }
  if (version > SCHEMA_VERSION) {
    throw new SchemaError(
      'newer',
      `保存データは新しいバージョンのエディタで作成されています（スキーマ v${version}）。`,
    );
  }
  let data = raw;
  if (version === 1) data = migrateV1toV2(data);
  return data;
}

/** 保存されたメタ情報（JSON 文字列）を検証して読み込む */
export function parseMeta(json: string): PersistedMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SchemaError('corrupt', '保存データを JSON として解析できません。');
  }
  if (!isObject(raw) || raw.app !== APP_ID) {
    throw new SchemaError('corrupt', '保存データの形式が正しくありません。');
  }
  const data = migrate(raw);
  if (!Array.isArray(data.tabs)) throw new SchemaError('corrupt', 'タブ情報が見つかりません。');
  const seen = new Set<string>();
  const tabs: PersistedTabMeta[] = [];
  for (const t of data.tabs) {
    const tab = parseTab(t);
    if (tab && !seen.has(tab.id)) {
      seen.add(tab.id);
      tabs.push(tab);
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    app: APP_ID,
    revision: typeof data.revision === 'number' && data.revision >= 0 ? data.revision : 0,
    writerId: typeof data.writerId === 'string' ? data.writerId : '',
    savedAt: typeof data.savedAt === 'number' ? data.savedAt : 0,
    activeTabId: typeof data.activeTabId === 'string' ? data.activeTabId : null,
    tabs,
    settings: normalizeSettings(data.settings),
    layout: parseLayout(data.layout, tabs),
  };
}

/** メタ情報から競合検知用の情報だけを取り出す（壊れていれば null） */
export function peekRevision(json: string | null): { revision: number; writerId: string } | null {
  if (json === null) return null;
  try {
    const raw = JSON.parse(json) as unknown;
    if (!isObject(raw)) return null;
    return {
      revision: typeof raw.revision === 'number' ? raw.revision : 0,
      writerId: typeof raw.writerId === 'string' ? raw.writerId : '',
    };
  } catch {
    return null;
  }
}

/** 画面分割の状態を検証する（存在しないタブ・重複・範囲外の値は補正する） */
function parseLayout(raw: unknown, tabs: PersistedTabMeta[]): PaneLayoutState {
  const layout = new PaneLayout();
  layout.load(isObject(raw) ? (raw as Partial<PaneLayoutState>) : null, tabs.map((t) => t.id), true);
  return layout.toJSON();
}
