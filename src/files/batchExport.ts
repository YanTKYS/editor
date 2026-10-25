import { zipSync, type Zippable } from 'fflate';
import type { TabMeta } from '../core/types';
import { encodeForExport, exportFileName, sanitizeFileName } from './fileIO';

export type BatchExportFile = Pick<TabMeta, 'id' | 'name' | 'mode' | 'eol' | 'bom' | 'encoding'> & {
  tabNumber: number;
  fileName: string;
};
export interface BatchExportSnapshot extends BatchExportFile { content: string }

const encoder = new TextEncoder();
function shorten(name: string, budget: number): string {
  let result = '';
  let size = 0;
  for (const char of name) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > budget) break;
    result += char;
    size += bytes;
  }
  return result;
}

/** ZIP 内にディレクトリを作らず、一般的なOSで使える名前と衝突しない連番を決める。 */
export function batchExportFiles(tabs: readonly TabMeta[]): BatchExportFile[] {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  const keyFor = (name: string) => name.toUpperCase().normalize('NFC');
  return tabs.flatMap((tab, index) => {
    if (!tab.modifiedSinceFile) return [];
    const base = sanitizeFileName(tab.name).replace(/[. ]+$/, '') || 'untitled';
    const name = exportFileName(base, tab.mode).normalize('NFC');
    const dot = name.lastIndexOf('.');
    let stem = (dot > 0 ? name.slice(0, dot) : name).replace(/[. ]+$/, '') || 'untitled';
    const extension = dot > 0 ? shorten(name.slice(dot), 64) : '';
    const device = stem.split('.')[0].trimEnd();
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i.test(device)) stem = '_' + stem;
    let fileName = '';
    const baseKey = keyFor(shorten(stem, 255 - encoder.encode(extension).length) + extension);
    for (let n = nextSuffix.get(baseKey) ?? 1; ; n++) {
      const suffix = n === 1 ? '' : ` (${n})`;
      fileName = shorten(stem, 255 - encoder.encode(suffix + extension).length) + suffix + extension;
      const key = keyFor(fileName);
      if (!used.has(key)) {
        used.add(key);
        nextSuffix.set(baseKey, n + 1);
        break;
      }
    }
    return [{ ...tab, tabNumber: index + 1, fileName }];
  });
}

export function sameExportMetadata(file: BatchExportFile, tab: TabMeta | null): boolean {
  return !!tab && file.id === tab.id && file.name === tab.name && file.mode === tab.mode &&
    file.eol === tab.eol && file.bom === tab.bom && file.encoding === tab.encoding;
}

/** 圧縮用 Worker を使わず、静的配信・既存 CSP のまま ZIP を生成する。 */
export function batchExportArchive(files: readonly BatchExportSnapshot[]): Blob {
  if (!files.length) throw new Error('書き出し対象がありません。');
  if (files.length > 65535) throw new Error('一度に書き出せるファイル数を超えています。');
  const entries: Zippable = Object.create(null);
  for (const file of files) {
    if (Object.hasOwn(entries, file.fileName)) throw new Error('書き出しファイル名が重複しています。');
    entries[file.fileName] = encodeForExport(file.content, file.eol, file.bom);
  }
  return new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: 'application/zip' });
}
