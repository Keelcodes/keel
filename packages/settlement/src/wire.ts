import { SettlementError } from './types.js';

/**
 * Base64 / base64url and UTF-8 codecs, plus the HTTP auth-param grammar both
 * payment protocols lean on.
 *
 * Written against plain ES2022 rather than `Buffer`/`atob` on purpose: the
 * settlement core carries no runtime dependency and must run in Node, browsers
 * and edge workers alike.
 */

const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const DECODE_TABLE: ReadonlyMap<string, number> = (() => {
  const table = new Map<string, number>();
  for (let index = 0; index < 64; index += 1) {
    table.set(STD_ALPHABET.charAt(index), index);
    table.set(URL_ALPHABET.charAt(index), index);
  }
  return table;
})();

function utf8Encode(input: string): number[] {
  const bytes: number[] = [];
  for (const char of input) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function utf8Decode(bytes: readonly number[]): string {
  let out = '';
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] as number;
    let codePoint: number;
    let width: number;
    if (lead < 0x80) {
      codePoint = lead;
      width = 1;
    } else if ((lead & 0xe0) === 0xc0) {
      codePoint = lead & 0x1f;
      width = 2;
    } else if ((lead & 0xf0) === 0xe0) {
      codePoint = lead & 0x0f;
      width = 3;
    } else if ((lead & 0xf8) === 0xf0) {
      codePoint = lead & 0x07;
      width = 4;
    } else {
      throw new SettlementError('malformed-payload', `invalid UTF-8 lead byte 0x${lead.toString(16)}`);
    }
    if (index + width > bytes.length) {
      throw new SettlementError('malformed-payload', 'truncated UTF-8 sequence');
    }
    for (let offset = 1; offset < width; offset += 1) {
      const continuation = bytes[index + offset] as number;
      if ((continuation & 0xc0) !== 0x80) {
        throw new SettlementError('malformed-payload', 'invalid UTF-8 continuation byte');
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    out += String.fromCodePoint(codePoint);
    index += width;
  }
  return out;
}

/** Encodes UTF-8 text as base64 (standard, padded) or base64url (unpadded). */
export function base64Encode(input: string, options: { urlSafe?: boolean } = {}): string {
  const urlSafe = options.urlSafe ?? false;
  const alphabet = urlSafe ? URL_ALPHABET : STD_ALPHABET;
  const bytes = utf8Encode(input);

  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] as number;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += alphabet.charAt(b0 >> 2);
    out += alphabet.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    out += b1 === undefined ? (urlSafe ? '' : '=') : alphabet.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    out += b2 === undefined ? (urlSafe ? '' : '=') : alphabet.charAt(b2 & 0x3f);
  }
  return out;
}

/** Decodes base64 or base64url (padding optional) back to UTF-8 text. */
export function base64Decode(input: string): string {
  const cleaned = input.replace(/\s+/g, '').replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of cleaned) {
    const value = DECODE_TABLE.get(char);
    if (value === undefined) {
      throw new SettlementError('malformed-payload', `invalid base64 character ${JSON.stringify(char)}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return utf8Decode(bytes);
}

/** Encodes a value as base64(url) JSON — how both protocols carry a payload. */
export function encodeJsonPayload(value: unknown, options: { urlSafe?: boolean } = {}): string {
  return base64Encode(JSON.stringify(value), options);
}

/** Decodes base64(url) JSON, reporting a `malformed-payload` error on bad input. */
export function decodeJsonPayload<T>(input: string): T {
  const text = base64Decode(input);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SettlementError('malformed-payload', `payload is not valid JSON: ${text.slice(0, 120)}`);
  }
}

export interface AuthHeader {
  scheme: string;
  params: Record<string, string>;
}

const WHITESPACE = /\s/;
const SEPARATOR = /[\s,]/;

/**
 * Reads just the auth scheme. Useful for rejecting a foreign scheme before
 * parsing params — `Bearer abc` is not an auth-param header at all, and the
 * error worth reporting is "wrong scheme", not "malformed parameters".
 */
export function authScheme(headerValue: string): string {
  return /^([^\s]+)/.exec(headerValue.trim())?.[1] ?? '';
}

/**
 * Parses an HTTP auth header (`Scheme a="1", b=2`) as defined by RFC 9110
 * §11.2. Handles quoted-string values containing commas and escapes — which is
 * exactly what a base64 payload in a challenge param looks like.
 */
export function parseAuthHeader(headerValue: string): AuthHeader {
  const trimmed = headerValue.trim();
  if (trimmed === '') {
    throw new SettlementError('malformed-payload', 'empty auth header');
  }

  let index = 0;
  while (index < trimmed.length && !WHITESPACE.test(trimmed.charAt(index))) index += 1;
  const scheme = trimmed.slice(0, index);
  const params: Record<string, string> = {};

  while (index < trimmed.length) {
    while (index < trimmed.length && (SEPARATOR.test(trimmed.charAt(index)))) index += 1;
    if (index >= trimmed.length) break;

    const nameStart = index;
    while (index < trimmed.length && trimmed.charAt(index) !== '=' && !SEPARATOR.test(trimmed.charAt(index))) {
      index += 1;
    }
    const name = trimmed.slice(nameStart, index);
    if (name === '') {
      throw new SettlementError('malformed-payload', `empty auth-param name in ${JSON.stringify(headerValue)}`);
    }

    while (index < trimmed.length && WHITESPACE.test(trimmed.charAt(index))) index += 1;
    if (trimmed.charAt(index) !== '=') {
      throw new SettlementError('malformed-payload', `auth-param ${name} has no value`);
    }
    index += 1;
    while (index < trimmed.length && WHITESPACE.test(trimmed.charAt(index))) index += 1;

    if (trimmed.charAt(index) === '"') {
      index += 1;
      let value = '';
      let closed = false;
      while (index < trimmed.length) {
        const char = trimmed.charAt(index);
        if (char === '\\') {
          const escaped = trimmed.charAt(index + 1);
          if (escaped === '') {
            throw new SettlementError('malformed-payload', 'dangling escape in quoted auth-param');
          }
          value += escaped;
          index += 2;
          continue;
        }
        if (char === '"') {
          closed = true;
          index += 1;
          break;
        }
        value += char;
        index += 1;
      }
      if (!closed) {
        throw new SettlementError('malformed-payload', `unterminated quoted value for auth-param ${name}`);
      }
      params[name] = value;
    } else {
      const valueStart = index;
      while (index < trimmed.length && !SEPARATOR.test(trimmed.charAt(index))) index += 1;
      params[name] = trimmed.slice(valueStart, index);
    }
  }

  return { scheme, params };
}

/** Serialises an auth header, quoting and escaping every value. */
export function formatAuthHeader(header: AuthHeader): string {
  const entries = Object.entries(header.params);
  if (entries.length === 0) return header.scheme;
  const rendered = entries
    .map(([name, value]) => `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(', ');
  return `${header.scheme} ${rendered}`;
}
