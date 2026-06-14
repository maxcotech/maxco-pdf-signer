// VERIFICATION: After preparePdfForSigning(), verify ByteRange invariant:
//   length1 + 1 + contentsLength + 1 + length2 === pdfBuffer.length
// Any failure throws ByteRangeError immediately.
//
// Strategy: incremental-update approach.
//   1. pdf-lib sets up AcroForm + widget annotation (without /V)
//   2. pdf-lib serialises the base PDF with useObjectStreams:false
//   3. We append a raw incremental update containing:
//        – the Sig dictionary (with fixed-width ByteRange/Contents placeholders)
//        – the updated widget (same object number, now with /V)
//        – a new xref table
//        – a new trailer with /Prev
//   4. We locate the ByteRange placeholder and update it in-place (same byte count)
//
// ISO 32000-1 §7.5.7: object streams compress xref data. useObjectStreams:false is
// mandatory so every object offset is an absolute, predictable byte position.

import * as fs from 'fs';
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFNumber, PDFString, PDFRef } from 'pdf-lib';
import { ByteRangeError, InvalidPdfError, SignatureOverflowError } from '../errors';
import { writeAsciiInPlace, padNumber, stringToPdfHex } from '../utils/bufferUtils';
import type { SignaturePlaceholderOptions, ByteRange, PreparedPdf } from './PdfEngine.types';

// The ByteRange placeholder is exactly 45 chars:
// '[0000000000 0000000000 0000000000 0000000000]'
//  1 + 10 + 1 + 10 + 1 + 10 + 1 + 10 + 1 = 45
const BYTE_RANGE_PLACEHOLDER = '[0000000000 0000000000 0000000000 0000000000]';
const BYTE_RANGE_PLACEHOLDER_LEN = BYTE_RANGE_PLACEHOLDER.length; // 45

const BYTE_RANGE_TOKEN = Buffer.from('/ByteRange ');
const CONTENTS_TOKEN = Buffer.from('/Contents <');

export class PdfEngine {
  /**
   * Prepare a PDF buffer for signing by:
   *   1. Adding an AcroForm signature field
   *   2. Appending a raw Sig dictionary with fixed-width ByteRange + Contents placeholders
   *   3. Computing the real ByteRange and writing it in-place
   *
   * Returns a PreparedPdf whose pdfBuffer has the ByteRange set correctly and a zero-filled
   * /Contents slot ready to receive the PKCS#7 hex string.
   *
   * @throws InvalidPdfError if the input is unreadable or encrypted
   * @throws ByteRangeError if the ByteRange invariant cannot be satisfied
   */
  async preparePdfForSigning(
    pdfInput: Buffer,
    options: SignaturePlaceholderOptions,
  ): Promise<PreparedPdf> {
    const placeholderSize = options.placeholderSize ?? 16384;
    const signingDate = options.signingDate ?? new Date();

    // ── Step 1: Load and validate ─────────────────────────────────────────────
    let pdfDoc: PDFDocument;
    try {
      pdfDoc = await PDFDocument.load(pdfInput, {
        updateMetadata: false,
        ignoreEncryption: false,
      });
    } catch (err) {
      throw new InvalidPdfError(`Cannot load PDF: ${String(err)}`);
    }

    // ── Step 2: Ensure AcroForm exists ────────────────────────────────────────
    // ISO 32000-1 §12.7.2: a Catalog must have an AcroForm entry for sig fields.
    if (!pdfDoc.catalog.has(PDFName.of('AcroForm'))) {
      pdfDoc.catalog.set(
        PDFName.of('AcroForm'),
        pdfDoc.context.obj({ Fields: pdfDoc.context.obj([]) }),
      );
    }

    // ── Step 3: Create the signature widget annotation ────────────────────────
    // ISO 32000-1 Table 164: F=132 means Print (4) + Lock (128) annotation flags.
    // Both AcroForm/Fields and Page/Annots must reference the widget for Adobe recognition.
    const widgetRef = pdfDoc.context.nextRef();
    const widgetObjNum = widgetRef.objectNumber;

    const widgetDict = pdfDoc.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Widget'),
      FT: PDFName.of('Sig'),
      Rect: pdfDoc.context.obj([
        PDFNumber.of(0),
        PDFNumber.of(0),
        PDFNumber.of(0),
        PDFNumber.of(0),
      ]),
      T: PDFString.of(this.uniqueFieldName(pdfDoc)),
      F: PDFNumber.of(132),
    });
    pdfDoc.context.assign(widgetRef, widgetDict);

    // Link widget into AcroForm Fields array
    const acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    let fields: PDFArray;
    if (acroForm.has(PDFName.of('Fields'))) {
      fields = acroForm.lookup(PDFName.of('Fields'), PDFArray);
    } else {
      fields = pdfDoc.context.obj([]) as PDFArray;
      acroForm.set(PDFName.of('Fields'), fields);
    }
    fields.push(widgetRef);

    // Link widget into Page 0 Annots array
    const page0 = pdfDoc.getPage(0);
    if (!page0.node.has(PDFName.of('Annots'))) {
      page0.node.set(PDFName.of('Annots'), pdfDoc.context.obj([]));
    }
    const annots = page0.node.lookup(PDFName.of('Annots'), PDFArray);
    annots.push(widgetRef);

    // ── Step 4: Serialise with useObjectStreams:false ──────────────────────────
    // ISO 32000-1 §7.5.7: object streams (PDF 1.5+) compress xref data.
    // Disabling ensures every object byte offset is absolute and deterministic.
    const basePdfBytes = await pdfDoc.save({ useObjectStreams: false });
    const basePdfBuffer = Buffer.from(basePdfBytes);

    // ── Step 5: Parse base PDF trailer ───────────────────────────────────────
    const { prevStartxref, prevSize, rootRef } = parseLastTrailer(basePdfBuffer);

    // Assign new object number for the Sig dictionary
    const sigObjNum = prevSize; // next available slot (0-indexed Size means count)

    // ── Build raw incremental update ──────────────────────────────────────────
    const contentsHex = '0'.repeat(placeholderSize * 2); // placeholder hex zeros

    // Raw Sig dictionary bytes
    const sigDictStr = buildRawSigDict(sigObjNum, options, contentsHex, signingDate);
    const sigDictBuf = Buffer.from(sigDictStr, 'binary');

    // Raw updated widget bytes (adds /V → Sig dict reference)
    const widgetStr = buildRawWidgetDict(widgetObjNum, 0, sigObjNum);
    const widgetBuf = Buffer.from(widgetStr, 'binary');

    // Byte offsets from start of the FULL combined buffer
    const sigDictOffset = basePdfBuffer.length;
    const widgetOffset = sigDictOffset + sigDictBuf.length;
    const xrefOffset = widgetOffset + widgetBuf.length;

    // xref section
    const xrefStr = buildXrefSection(sigObjNum, sigDictOffset, widgetObjNum, widgetOffset);
    const xrefBuf = Buffer.from(xrefStr, 'binary');

    // new trailer
    const trailerStr = buildTrailer(prevSize + 1, prevStartxref, xrefOffset, rootRef);
    const trailerBuf = Buffer.from(trailerStr, 'binary');

    // Concatenate: base PDF + incremental update
    const pdfBuffer = Buffer.concat([basePdfBuffer, sigDictBuf, widgetBuf, xrefBuf, trailerBuf]);

    // ── Step 6: Locate /ByteRange [ in buffer ────────────────────────────────
    const byteRangeTokenOffset = pdfBuffer.indexOf(BYTE_RANGE_TOKEN, basePdfBuffer.length);
    if (byteRangeTokenOffset === -1) {
      throw new ByteRangeError('Could not find /ByteRange token in prepared buffer');
    }
    // The '[' is immediately after the token
    const byteRangeValueOffset = byteRangeTokenOffset + BYTE_RANGE_TOKEN.length;

    // ── Step 7: Locate /Contents < in buffer ─────────────────────────────────
    const contentsTokenOffset = pdfBuffer.indexOf(CONTENTS_TOKEN, basePdfBuffer.length);
    if (contentsTokenOffset === -1) {
      throw new ByteRangeError('Could not find /Contents token in prepared buffer');
    }
    // contentsOffset = position of first hex char (byte after '<')
    const contentsOffset = contentsTokenOffset + CONTENTS_TOKEN.length;
    const contentsLength = placeholderSize * 2;

    // ── Step 8: Compute ByteRange ─────────────────────────────────────────────
    // Segment1: bytes [0, contentsOffset-2] — everything before '<'
    // Excluded: '<' (1) + hex (contentsLength) + '>' (1)
    // Segment2: bytes [offset2, end] — everything after '>'
    //
    // Length breakdown: length1 + 1('<') + contentsLength + 1('>') + length2 = fileSize
    const length1 = contentsOffset - 1; // bytes 0..(contentsOffset-2), NOT including '<'
    const offset2 = contentsOffset + contentsLength + 1; // byte after closing '>'
    const length2 = pdfBuffer.length - offset2;

    const byteRange: ByteRange = {
      offset1: 0,
      length1,
      offset2,
      length2,
    };

    // ── Invariant assertion (ISO 32000-1 §12.8.1) ────────────────────────────
    const check = length1 + 1 + contentsLength + 1 + length2;
    // Breakdown: segment1 + '<' char + hex placeholder + '>' char + segment2
    if (check !== pdfBuffer.length) {
      throw new ByteRangeError(
        `Invariant violated: ${length1}+1+${contentsLength}+1+${length2}=${check} ` +
          `!== fileSize ${pdfBuffer.length}`,
      );
    }

    // ── Step 9: Write real ByteRange into buffer in-place ────────────────────
    // The placeholder '[0000000000 0000000000 0000000000 0000000000]' is exactly 45 chars.
    // The real value uses the same format, so the byte count is unchanged.
    // We use Buffer.write() — NEVER string concat or Buffer.concat, which would resize.
    const byteRangeStr =
      `[${padNumber(byteRange.offset1, 10)} ` +
      `${padNumber(byteRange.length1, 10)} ` +
      `${padNumber(byteRange.offset2, 10)} ` +
      `${padNumber(byteRange.length2, 10)}]`;

    if (byteRangeStr.length !== BYTE_RANGE_PLACEHOLDER_LEN) {
      throw new ByteRangeError(
        `ByteRange string length ${byteRangeStr.length} !== expected ${BYTE_RANGE_PLACEHOLDER_LEN}`,
      );
    }

    writeAsciiInPlace(pdfBuffer, byteRangeStr, byteRangeValueOffset);

    // ── Step 10: Return PreparedPdf ───────────────────────────────────────────
    return { pdfBuffer, byteRange, contentsOffset, contentsLength };
  }

  /**
   * Extract the bytes covered by the ByteRange — the exact bytes whose integrity
   * is proven by the signature. Any modification to ANY byte here (including the
   * embedded signature image) will produce a different SHA-256 hash.
   */
  extractSignableBytes(prepared: PreparedPdf): Buffer {
    return Buffer.concat([
      prepared.pdfBuffer.subarray(
        prepared.byteRange.offset1,
        prepared.byteRange.offset1 + prepared.byteRange.length1,
      ),
      prepared.pdfBuffer.subarray(
        prepared.byteRange.offset2,
        prepared.byteRange.offset2 + prepared.byteRange.length2,
      ),
    ]);
  }

  /**
   * Write the PKCS#7 hex string into the /Contents placeholder slot.
   *
   * Uses in-place Buffer.write() so the buffer length never changes.
   *
   * @throws SignatureOverflowError if pkcs7HexString exceeds the allocated slot
   */
  injectSignature(prepared: PreparedPdf, pkcs7HexString: string): Buffer {
    if (pkcs7HexString.length > prepared.contentsLength) {
      throw new SignatureOverflowError(
        pkcs7HexString.length / 2, // bytes
        prepared.contentsLength / 2, // bytes
      );
    }

    // Right-pad with '0' to fill the exact allocated slot (null-padded PKCS#7)
    const paddedHex = pkcs7HexString.padEnd(prepared.contentsLength, '0');

    // In-place write — NEVER use Buffer.concat or string operations here
    writeAsciiInPlace(prepared.pdfBuffer, paddedHex, prepared.contentsOffset);

    return prepared.pdfBuffer;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private uniqueFieldName(pdfDoc: PDFDocument): string {
    // Check for existing Signature fields to avoid name collisions
    if (pdfDoc.catalog.has(PDFName.of('AcroForm'))) {
      const acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
      if (acroForm.has(PDFName.of('Fields'))) {
        const fields = acroForm.lookup(PDFName.of('Fields'), PDFArray);
        const count = fields.size();
        if (count > 0) return `Signature${count + 1}`;
      }
    }
    return 'Signature1';
  }
}

// ─── PDF incremental-update helpers ──────────────────────────────────────────

/**
 * Format a PDF date string per ISO 32000-1 §7.9.4.
 * Format: D:YYYYMMDDHHmmssZ
 * Do NOT use Date.toISOString() — it produces ISO 8601 with wrong separators.
 */
export function formatPdfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `D:${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}` +
    `${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * Build the raw text of a Sig dictionary object for an incremental update.
 *
 * The /ByteRange entry is written as the fixed 45-char placeholder that will be
 * overwritten in-place once the real offsets are known.
 *
 * String values (reason, location, etc.) are encoded as PDF hex strings (<...>)
 * to avoid all escaping complexities with literal strings.
 */
function buildRawSigDict(
  objNum: number,
  options: SignaturePlaceholderOptions,
  contentsHex: string,
  signingDate: Date,
): string {
  const subFilter = options.subFilter ?? 'adbe.pkcs7.detached';
  const dateStr = formatPdfDate(signingDate);

  let dict = `${objNum} 0 obj\n<<\n`;
  dict += `/Type /Sig\n`;
  dict += `/Filter /Adobe.PPKLite\n`;
  dict += `/SubFilter /${subFilter}\n`;
  // Fixed-width ByteRange placeholder — will be overwritten in-place (§12.8.1)
  dict += `/ByteRange ${BYTE_RANGE_PLACEHOLDER}\n`;
  // Fixed-length /Contents hex placeholder — zero-padded, will be overwritten
  dict += `/Contents <${contentsHex}>\n`;
  // Optional metadata fields encoded as PDF hex strings
  if (options.reason) dict += `/Reason <${stringToPdfHex(options.reason)}>\n`;
  // PDF date format — NOT ISO 8601
  dict += `/M (${dateStr})\n`;
  if (options.name) dict += `/Name <${stringToPdfHex(options.name)}>\n`;
  if (options.location) dict += `/Location <${stringToPdfHex(options.location)}>\n`;
  if (options.contactInfo) dict += `/ContactInfo <${stringToPdfHex(options.contactInfo)}>\n`;
  dict += `>>\nendobj\n`;

  return dict;
}

/**
 * Build the raw text of an updated widget dict for the incremental update.
 * This re-writes the same object (widgetObjNum) from the base PDF, now adding /V.
 */
function buildRawWidgetDict(widgetObjNum: number, genNum: number, sigObjNum: number): string {
  return (
    `${widgetObjNum} ${genNum} obj\n` +
    `<<\n` +
    `/Type /Annot\n` +
    `/Subtype /Widget\n` +
    `/FT /Sig\n` +
    `/Rect [0 0 0 0]\n` +
    `/T (Signature1)\n` +
    `/F 132\n` +
    `/V ${sigObjNum} 0 R\n` +
    `>>\n` +
    `endobj\n`
  );
}

/**
 * Build a cross-reference table for the incremental update.
 *
 * Each xref entry is exactly 20 bytes: OOOOOOOOOO GGGGG F SP LF
 * (10-digit offset + space + 5-digit gen + space + keyword + space + LF)
 */
function buildXrefSection(
  sigObjNum: number,
  sigObjOffset: number,
  widgetObjNum: number,
  widgetObjOffset: number,
): string {
  const fmtEntry = (offset: number) =>
    `${padNumber(offset, 10)} 00000 n \n`;

  let xref = 'xref\n';

  // Sort object numbers ascending; PDF xref subsections must be contiguous ranges
  const entries = [
    { num: sigObjNum, offset: sigObjOffset },
    { num: widgetObjNum, offset: widgetObjOffset },
  ].sort((a, b) => a.num - b.num);

  // Group into contiguous runs
  const runs: Array<Array<{ num: number; offset: number }>> = [];
  let currentRun: Array<{ num: number; offset: number }> = [];

  for (const entry of entries) {
    if (
      currentRun.length === 0 ||
      entry.num === currentRun[currentRun.length - 1].num + 1
    ) {
      currentRun.push(entry);
    } else {
      runs.push(currentRun);
      currentRun = [entry];
    }
  }
  runs.push(currentRun);

  for (const run of runs) {
    xref += `${run[0].num} ${run.length}\n`;
    for (const entry of run) {
      xref += fmtEntry(entry.offset);
    }
  }

  return xref;
}

/**
 * Build the new trailer dictionary + startxref for the incremental update.
 */
function buildTrailer(
  newSize: number,
  prevStartxref: number,
  newStartxrefOffset: number,
  rootRef: string,
): string {
  return (
    `trailer\n` +
    `<<\n` +
    `/Size ${newSize}\n` +
    `/Root ${rootRef}\n` +
    `/Prev ${prevStartxref}\n` +
    `>>\n` +
    `startxref\n` +
    `${newStartxrefOffset}\n` +
    `%%EOF\n`
  );
}

/**
 * Parse the last trailer of a pdf-lib-saved PDF to extract:
 *   - prevStartxref: the startxref value (needed as /Prev in incremental update)
 *   - prevSize: the /Size value (object count, used to allocate next object number)
 *   - rootRef: the /Root reference string (e.g. "5 0 R")
 */
function parseLastTrailer(buffer: Buffer): {
  prevStartxref: number;
  prevSize: number;
  rootRef: string;
} {
  // Use latin1 to preserve every byte value without encoding transformation
  const str = buffer.toString('latin1');

  // Find the last 'startxref' keyword
  const startxrefIdx = str.lastIndexOf('startxref');
  if (startxrefIdx === -1) {
    throw new InvalidPdfError('No startxref found in PDF');
  }
  const afterStartxref = str.slice(startxrefIdx + 9).trimStart();
  const prevStartxref = parseInt(afterStartxref, 10);
  if (isNaN(prevStartxref)) {
    throw new InvalidPdfError('Could not parse startxref value');
  }

  // Find the last trailer dictionary
  const trailerIdx = str.lastIndexOf('trailer');
  if (trailerIdx === -1) {
    throw new InvalidPdfError('No trailer found in PDF');
  }
  const trailerSection = str.slice(trailerIdx);

  // Extract /Size
  const sizeMatch = trailerSection.match(/\/Size\s+(\d+)/);
  if (!sizeMatch) {
    throw new InvalidPdfError('No /Size in PDF trailer');
  }
  const prevSize = parseInt(sizeMatch[1], 10);

  // Extract /Root
  const rootMatch = trailerSection.match(/\/Root\s+(\d+\s+\d+\s+R)/);
  if (!rootMatch) {
    throw new InvalidPdfError('No /Root in PDF trailer');
  }
  const rootRef = rootMatch[1].replace(/\s+/g, ' ');

  return { prevStartxref, prevSize, rootRef };
}
