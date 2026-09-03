/**
 * Read-only document introspection.
 *
 * A caller placing a signature stamp needs facts about the document before it
 * can build a StampPosition at all: how many pages there are, how big each one
 * is in points, and whether any page is rotated. Without those, a UI is reduced
 * to guessing — which is why this exists as a first-class operation rather than
 * something every integrator re-derives with their own PDF parser.
 *
 * It also answers the two questions worth asking at upload time rather than at
 * signing time: is the document encrypted (this library cannot sign it), and is
 * it already signed (signing again is legitimate but rarely what an app that
 * thinks it is handling a fresh upload intends).
 *
 * Nothing here mutates the document.
 */
import { PDFDocument, EncryptedPDFError } from 'pdf-lib';
import { InvalidPdfError } from '../errors';
import { normaliseRotation } from '../visual/coordinates';
import type { PdfInspection, PdfPageInfo } from './PdfEngine.types';

/**
 * Counts existing signature dictionaries by their /ByteRange entries.
 *
 * Scanning the raw bytes rather than walking the object graph is deliberate: a
 * signature in an incremental update may live in a revision pdf-lib's object
 * model does not surface as the current /AcroForm, and the question being
 * answered ("has anything ever been signed here?") is about the whole file.
 * latin1 keeps the byte-to-char mapping 1:1 so stream data cannot shift offsets.
 */
function countSignatures(pdfBuffer: Buffer): number {
  const text = pdfBuffer.toString('latin1');
  const matches = text.match(/\/ByteRange\s*\[/g);
  return matches ? matches.length : 0;
}

/** True when the error pdf-lib threw was specifically about encryption. */
function isEncryptionError(err: unknown): boolean {
  if (err instanceof EncryptedPDFError) return true;
  // Defensive: pdf-lib's error classes do not survive every bundling scheme, so
  // fall back to the message rather than misreporting an encrypted file as corrupt.
  return err instanceof Error && /encrypt/i.test(err.message);
}

/**
 * Describe a PDF without modifying it.
 *
 * @param pdfBuffer - the document to inspect
 * @returns page count, per-page geometry, and encryption/signature status
 * @throws InvalidPdfError if the buffer is not a PDF this library can read.
 *   An encrypted PDF is reported as `encrypted: true` rather than throwing,
 *   because that is a fact the caller needs in order to explain the rejection.
 */
export async function inspectPdf(pdfBuffer: Buffer): Promise<PdfInspection> {
  const signatureCount = countSignatures(pdfBuffer);

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(pdfBuffer, {
      updateMetadata: false,
      // Matches PdfEngine: an encrypted document cannot be signed by this
      // library, so surface it as a fact instead of loading it half-decoded.
      ignoreEncryption: false,
    });
  } catch (err) {
    if (isEncryptionError(err)) {
      return {
        sizeBytes: pdfBuffer.length,
        pageCount: 0,
        pages: [],
        encrypted: true,
        signatureCount,
        signable: false,
      };
    }
    throw new InvalidPdfError(`Failed to load PDF: ${String(err)}`);
  }

  const pages: PdfPageInfo[] = pdfDoc.getPages().map((page, index) => {
    const { width, height } = page.getSize();
    const rotation = normaliseRotation(page.getRotation().angle);
    const quarterTurned = rotation === 90 || rotation === 270;

    return {
      index,
      // User-space (MediaBox) dimensions. Stamp coordinates are in this space,
      // so these are the numbers stamp arithmetic must use.
      widthPts: width,
      heightPts: height,
      rotation,
      // What a viewer actually displays: /Rotate swaps the visible axes on a
      // quarter turn. A pixel rectangle measured over a rendered page is
      // relative to THIS box, not the MediaBox — hence both are reported.
      displayWidthPts: quarterTurned ? height : width,
      displayHeightPts: quarterTurned ? width : height,
    };
  });

  return {
    sizeBytes: pdfBuffer.length,
    pageCount: pages.length,
    pages,
    encrypted: false,
    signatureCount,
    signable: pages.length > 0,
  };
}
