import { decodeBytes, encodeUtf8, InvalidEncodingError, looksBinary } from '../core/encoding';
import { applyLineEnding, detectLineEnding, normalizeLineEndings } from '../core/lineEndings';
import { fileExtension, modeInfo } from '../core/modes';
import type { EditorMode, LineEnding, SourceEncoding } from '../core/types';

/** 読み込んだテキストファイル */
export interface LoadedFile {
  name: string;
  /** LF に正規化した本文 */
  content: string;
  eol: LineEnding;
  /** 改行コードが混在していた */
  mixedEol: boolean;
  encoding: SourceEncoding;
  bom: boolean;
  size: number;
}

export type ReadFileResult =
  | { ok: true; file: LoadedFile }
  | { ok: false; name: string; reason: 'binary' | 'encoding' | 'error'; message: string; bytes?: Uint8Array };

/** 大きなファイルの目安（これを超える場合は利用者に確認する） */
export const LARGE_FILE_BYTES = 2 * 1024 * 1024;

function readAsBytes(file: Blob): Promise<Uint8Array> {
  return file.arrayBuffer().then((buf) => new Uint8Array(buf));
}

/** バイト列をテキストファイルとして解釈する */
export function bytesToLoadedFile(
  name: string,
  bytes: Uint8Array,
  encoding: SourceEncoding,
  strict = true,
): ReadFileResult {
  if (looksBinary(bytes)) {
    return {
      ok: false,
      name,
      reason: 'binary',
      message: `「${name}」はバイナリファイルのようです（テキストファイルのみ開けます）。`,
    };
  }
  try {
    const decoded = decodeBytes(bytes, encoding, strict);
    const info = detectLineEnding(decoded.text);
    return {
      ok: true,
      file: {
        name,
        content: normalizeLineEndings(decoded.text),
        eol: info.eol,
        mixedEol: info.mixed,
        encoding: decoded.encoding,
        bom: decoded.bom,
        size: bytes.length,
      },
    };
  } catch (e) {
    if (e instanceof InvalidEncodingError) {
      return { ok: false, name, reason: 'encoding', message: e.message, bytes };
    }
    return { ok: false, name, reason: 'error', message: String(e) };
  }
}

export async function readTextFile(file: File, encoding: SourceEncoding): Promise<ReadFileResult> {
  try {
    const bytes = await readAsBytes(file);
    return bytesToLoadedFile(file.name, bytes, encoding);
  } catch (e) {
    return {
      ok: false,
      name: file.name,
      reason: 'error',
      message: `「${file.name}」を読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** ファイル選択ダイアログを開く。キャンセル時は空配列 */
export function pickFiles(options: { multiple?: boolean; accept?: string } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple ?? true;
    if (options.accept) input.accept = options.accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

/** ファイル名として使えない文字を置き換える */
export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+$/, '_').trim();
  return cleaned || 'untitled';
}

/** 書き出し用のファイル名（拡張子がなければモードに応じた拡張子を付ける） */
export function exportFileName(name: string, mode: EditorMode): string {
  const safe = sanitizeFileName(name);
  return fileExtension(safe) ? safe : `${safe}.${modeInfo(mode).defaultExt}`;
}

/** 書き出し用のバイト列（改行コード・BOM を反映した UTF-8） */
export function encodeForExport(content: string, eol: LineEnding, bom: boolean): Uint8Array {
  return encodeUtf8(applyLineEnding(content, eol), bom);
}

/** Blob をファイルとしてダウンロードさせる */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(
  content: string,
  fileName: string,
  eol: LineEnding,
  bom: boolean,
  mime = 'text/plain',
): void {
  const bytes = encodeForExport(content, eol, bom);
  downloadBlob(new Blob([bytes as BlobPart], { type: `${mime};charset=utf-8` }), fileName);
}

/** ドラッグ中のデータにファイルが含まれるか */
export function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
