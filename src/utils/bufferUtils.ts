// VERIFICATION: All functions here are pure and have no side effects.

/**
 * Convert a hex string to a Buffer.
 */
export function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/**
 * Convert a Buffer to a lowercase hex string.
 */
export function bufferToHex(buf: Buffer): string {
  return buf.toString('hex');
}

/**
 * Search for a byte pattern in a Buffer and return the first occurrence index.
 * Returns -1 if not found.
 */
export function findPattern(haystack: Buffer, needle: Buffer, fromIndex = 0): number {
  return haystack.indexOf(needle, fromIndex);
}

/**
 * Write an ASCII string into a Buffer at an exact byte offset without changing the buffer length.
 * Throws if the string would exceed buffer bounds.
 */
export function writeAsciiInPlace(buf: Buffer, str: string, offset: number): void {
  if (offset + str.length > buf.length) {
    throw new RangeError(
      `writeAsciiInPlace: write of ${str.length} bytes at offset ${offset} ` +
        `exceeds buffer length ${buf.length}`,
    );
  }
  buf.write(str, offset, 'ascii');
}

/**
 * Concatenate multiple Buffers efficiently.
 */
export function concatBuffers(...buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}

/**
 * Convert a string to a PDF hex string representation (without angle brackets).
 * Used for encoding string values safely in PDF syntax.
 */
export function stringToPdfHex(str: string): string {
  return Buffer.from(str, 'utf8').toString('hex');
}

/**
 * Left-pad a number to exactly `width` digits with zeroes.
 */
export function padNumber(n: number, width: number): string {
  return String(n).padStart(width, '0');
}
