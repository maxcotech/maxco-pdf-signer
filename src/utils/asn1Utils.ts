// VERIFICATION: All tag values from ITU-T X.690 §8. Every function cites the relevant section.

// ITU-T X.690 §8.1 — universal tag assignments
export const TAG_SEQUENCE = 0x30; // SEQUENCE (constructed)
export const TAG_SET = 0x31; // SET (constructed)
export const TAG_INTEGER = 0x02; // INTEGER (primitive)
export const TAG_OID = 0x06; // OBJECT IDENTIFIER (primitive)
export const TAG_OCTET_STRING = 0x04; // OCTET STRING (primitive)
export const TAG_NULL = 0x05; // NULL (primitive)
export const TAG_UTF8_STRING = 0x0c; // UTF8String (primitive)
export const TAG_PRINTABLE_STRING = 0x13; // PrintableString (primitive)
export const TAG_UTC_TIME = 0x17; // UTCTime (primitive)
export const TAG_BIT_STRING = 0x03; // BIT STRING (primitive)

// Context-specific constructed tags (ITU-T X.680/X.690)
export const TAG_CONTEXT_0 = 0xa0; // [0] context-specific constructed
export const TAG_CONTEXT_1 = 0xa1; // [1] context-specific constructed
export const TAG_CONTEXT_3 = 0xa3; // [3] context-specific constructed

/**
 * Encode a DER length value per ITU-T X.690 §8.1.3.
 *
 * Short form (§8.1.3.4): single byte, used when length < 128.
 * Long form (§8.1.3.5): first byte = 0x80 | n, followed by n bytes of length in big-endian.
 */
export function encodeDerLength(length: number): Buffer {
  if (length < 0) throw new RangeError('DER length must be non-negative');

  if (length < 128) {
    // Short form: §8.1.3.4
    return Buffer.from([length]);
  }

  // Long form: §8.1.3.5
  // Determine how many bytes are needed to represent `length`
  let tmp = length;
  let byteCount = 0;
  while (tmp > 0) {
    tmp >>>= 8;
    byteCount++;
  }

  const result = Buffer.allocUnsafe(1 + byteCount);
  result[0] = 0x80 | byteCount; // first byte: 0x80 OR number-of-length-bytes

  // Write length bytes in big-endian order
  for (let i = byteCount - 1; i >= 0; i--) {
    result[1 + i] = length & 0xff;
    length >>>= 8;
  }

  return result;
}

/**
 * Wrap content bytes with a DER tag and computed length per ITU-T X.690 §8.1.
 * Produces: [tag] [length...] [contents]
 */
export function derWrap(tag: number, contents: Buffer): Buffer {
  const lengthBytes = encodeDerLength(contents.length);
  const result = Buffer.allocUnsafe(1 + lengthBytes.length + contents.length);
  result[0] = tag;
  lengthBytes.copy(result, 1);
  contents.copy(result, 1 + lengthBytes.length);
  return result;
}

/**
 * Encode an OID string as DER per ITU-T X.690 §8.19.
 *
 * §8.19.4: First two components c0.c1 are encoded as 40*c0 + c1.
 * §8.19.5: Each subsequent component is encoded in base-128 big-endian with the high
 *          bit set on all bytes except the last (continuation flag).
 */
export function encodeOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  if (parts.length < 2) throw new Error(`Invalid OID: ${oid}`);

  const bytes: number[] = [];

  // §8.19.4: combine first two components
  bytes.push(40 * parts[0] + parts[1]);

  // §8.19.5: encode remaining components in base-128
  for (let i = 2; i < parts.length; i++) {
    let value = parts[i];
    const componentBytes: number[] = [];
    componentBytes.push(value & 0x7f); // low 7 bits, no continuation
    value >>>= 7;
    while (value > 0) {
      componentBytes.unshift((value & 0x7f) | 0x80); // 7 bits with continuation flag
      value >>>= 7;
    }
    bytes.push(...componentBytes);
  }

  return derWrap(TAG_OID, Buffer.from(bytes));
}

/**
 * Encode a non-negative integer as DER per ITU-T X.690 §8.3.
 *
 * §8.3.2: The value is in two's complement. For positive numbers, prepend 0x00
 *         if the high bit of the first content byte would be 1 (to preserve positive sign).
 */
export function encodeInteger(value: Buffer): Buffer {
  let content = value;

  // Remove unnecessary leading zero bytes (but not if it would make the high bit set)
  while (content.length > 1 && content[0] === 0x00 && (content[1] & 0x80) === 0) {
    content = content.subarray(1);
  }

  // Prepend 0x00 if high bit is set (§8.3.2 — positive sign preservation)
  if (content[0] & 0x80) {
    content = Buffer.concat([Buffer.from([0x00]), content]);
  }

  return derWrap(TAG_INTEGER, content);
}

/**
 * Encode a raw integer value (JavaScript number) as DER INTEGER.
 */
export function encodeIntegerValue(value: number): Buffer {
  // Convert to big-endian bytes
  let v = value;
  const bytes: number[] = [];
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return encodeInteger(Buffer.from(bytes));
}

/**
 * Encode a UTCTime value as DER per ITU-T X.680 §43.
 *
 * Format: YYMMDDHHMMSSZ (2-digit year, UTC indicated by trailing 'Z').
 * ITU-T X.690 §11.8 requires this canonical form.
 */
export function encodeUtcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getUTCFullYear() % 100; // 2-digit year
  const str =
    `${pad(year)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return derWrap(TAG_UTC_TIME, Buffer.from(str, 'ascii'));
}

/**
 * Encode a NULL value as DER per ITU-T X.690 §8.8.
 */
export function encodeNull(): Buffer {
  return Buffer.from([TAG_NULL, 0x00]);
}

/**
 * Build an AlgorithmIdentifier SEQUENCE for a given algorithm OID with NULL parameters.
 * Used for digest and signature algorithms in CMS structures.
 */
export function encodeAlgorithmIdentifier(oidStr: string): Buffer {
  // AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY OPTIONAL }
  const oidDer = encodeOid(oidStr);
  const nullDer = encodeNull();
  return derWrap(TAG_SEQUENCE, Buffer.concat([oidDer, nullDer]));
}

/**
 * Build an AlgorithmIdentifier SEQUENCE for SHA-256.
 * OID 2.16.840.1.101.3.4.2.1 — NIST FIPS 180-4 / RFC 5754
 */
export function encodeSha256AlgorithmIdentifier(): Buffer {
  return encodeAlgorithmIdentifier('2.16.840.1.101.3.4.2.1');
}
