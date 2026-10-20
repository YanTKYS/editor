import type { SourceEncoding } from './types';

export interface DecodeResult {
  text: string;
  encoding: SourceEncoding;
  bom: boolean;
}

export class InvalidEncodingError extends Error {
  constructor(public readonly encoding: SourceEncoding) {
    super(`${encoding} として正しく読み込めないバイト列が含まれています`);
    this.name = 'InvalidEncodingError';
  }
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/**
 * バイト列をテキストに復号する。
 * strict = true の場合、不正なバイト列があれば InvalidEncodingError を送出する。
 */
export function decodeBytes(
  bytes: Uint8Array,
  encoding: SourceEncoding,
  strict = true,
): DecodeResult {
  if (encoding === 'UTF-8') {
    const bom = hasUtf8Bom(bytes);
    const body = bom ? bytes.subarray(3) : bytes;
    try {
      const text = new TextDecoder('utf-8', { fatal: strict, ignoreBOM: true }).decode(body);
      return { text, encoding, bom };
    } catch {
      throw new InvalidEncodingError(encoding);
    }
  }
  try {
    const text = new TextDecoder('shift_jis', { fatal: strict }).decode(bytes);
    return { text, encoding, bom: false };
  } catch {
    throw new InvalidEncodingError(encoding);
  }
}

/** UTF-8（必要に応じて BOM 付き）にエンコードする */
export function encodeUtf8(text: string, bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}

/**
 * バイナリファイルらしいかを判定する（先頭 8KB に NUL を含む場合）。
 * UTF-16 等のテキストも NUL を含むが、本エディタは非対応のため同様に扱う。
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
