// VERIFICATION: The stamped PDF must not contain /ObjStm — verify with:
//   strings stamped.pdf | grep ObjStm
// If /ObjStm appears, useObjectStreams:false was not applied correctly.
//
// PDF coordinate system: origin BOTTOM-LEFT, Y increases UPWARD
// Browser/canvas:        origin TOP-LEFT,    Y increases DOWNWARD
//
// Conversion (browser canvas at screenDPI to PDF points):
//   pdfX = canvasX * (72 / screenDPI)
//   pdfY = pageHeightPts - (canvasY * (72 / screenDPI)) - stampHeightPts
//
// Common page sizes in points (width x height):
//   A4:     595.28 x 841.89
//   Letter: 612.00 x 792.00
//   Legal:  612.00 x 1008.00
//   A3:     841.89 x 1190.55

import { PDFDocument } from 'pdf-lib';
import { rasteriseSvgToPng, generateTextSignatureSvg } from './svgToPdf';
import {
  InvalidAppearanceError,
  InvalidPositionError,
  InvalidPdfError,
} from '../errors';
import type { SignatureAppearance, StampPosition, VisualStampResult } from './VisualStamper.types';

export class VisualStamper {
  /**
   * Apply a visual signature stamp to a PDF page and return the modified PDF buffer.
   *
   * Execution order (must not be changed):
   * 1. Validate position (page exists, width/height > 0)
   * 2. Validate appearance (exactly one of svgString/text provided)
   * 3. Resolve SVG (use svgString directly, or generate from text)
   * 4. Rasterise SVG to PNG at (width * renderScale) x (height * renderScale) pixels
   * 5. Load PDF with PDFDocument.load(..., { updateMetadata: false })
   * 6. Embed PNG with pdfDoc.embedPng(pngBuffer)
   * 7. Draw image with page.drawImage(image, { x, y, width, height })
   * 8. Serialise with pdfDoc.save({ useObjectStreams: false })
   * 9. Return VisualStampResult
   *
   * IMPORTANT: The returned stampedPdfBuffer feeds directly into PdfEngine.
   * useObjectStreams:false is mandatory — ISO 32000-1 §7.5.7: object streams
   * compress xref data, making byte offsets indeterminate for ByteRange calculation.
   *
   * @throws InvalidPdfError if PDF cannot be loaded
   * @throws InvalidAppearanceError if neither svgString nor text is provided
   * @throws InvalidPositionError if page index out of range or dimensions <= 0
   */
  async applyStamp(
    pdfBuffer: Buffer,
    appearance: SignatureAppearance,
    position: StampPosition,
  ): Promise<VisualStampResult> {
    // Step 1: Validate position
    if (position.width <= 0 || position.height <= 0) {
      throw new InvalidPositionError(
        `Stamp width and height must be > 0, got ${position.width}x${position.height}`,
      );
    }

    // Step 2: Validate appearance — exactly one source required
    const hasSvg = Boolean(appearance.svgString);
    const hasText = Boolean(appearance.text);
    if (!hasSvg && !hasText) {
      throw new InvalidAppearanceError(
        'Either svgString or text must be provided in SignatureAppearance',
      );
    }
    if (hasSvg && hasText) {
      throw new InvalidAppearanceError(
        'Provide exactly one of svgString or text, not both',
      );
    }

    // Step 3: Resolve SVG string
    let svgString: string;
    if (hasSvg) {
      svgString = appearance.svgString!;
      if (!svgString.includes('viewBox') && !svgString.includes('viewbox')) {
        throw new InvalidAppearanceError(
          'svgString must include a viewBox attribute for reliable rasterisation',
        );
      }
    } else {
      const fontSize = appearance.fontSize ?? 32;
      const color = appearance.color ?? '#1a1a2e';
      svgString = generateTextSignatureSvg(appearance.text!, fontSize, color);
    }

    // Step 4: Rasterise SVG → PNG at scaled dimensions
    const scale = appearance.renderScale ?? 2;
    const pxWidth = Math.max(1, Math.round(position.width * scale));
    const pxHeight = Math.max(1, Math.round(position.height * scale));

    let pngBuffer: Buffer;
    try {
      pngBuffer = await rasteriseSvgToPng(svgString, pxWidth, pxHeight);
    } catch (err) {
      throw new InvalidAppearanceError(`SVG rasterisation failed: ${String(err)}`);
    }

    // Step 5: Load PDF
    let pdfDoc: PDFDocument;
    try {
      pdfDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
    } catch (err) {
      throw new InvalidPdfError(`Failed to load PDF: ${String(err)}`);
    }

    // Validate page index
    const pageCount = pdfDoc.getPageCount();
    if (position.page < 0 || position.page >= pageCount) {
      throw new InvalidPositionError(
        `Page index ${position.page} out of range (document has ${pageCount} pages, indices 0–${pageCount - 1})`,
      );
    }

    // Step 6: Embed PNG
    let image: Awaited<ReturnType<typeof pdfDoc.embedPng>>;
    try {
      image = await pdfDoc.embedPng(pngBuffer);
    } catch (err) {
      throw new InvalidAppearanceError(`Failed to embed PNG in PDF: ${String(err)}`);
    }

    // Step 7: Draw image at the specified stamp position
    const page = pdfDoc.getPage(position.page);
    page.drawImage(image, {
      x: position.x,
      y: position.y,
      width: position.width,
      height: position.height,
    });

    // Step 8: Serialise — useObjectStreams MUST be false.
    // ISO 32000-1 §7.5.7: object streams compress xref data. We disable them so
    // every object offset is an absolute byte position addressable for ByteRange calculation.
    const stampedBytes = await pdfDoc.save({ useObjectStreams: false });
    const stampedPdfBuffer = Buffer.from(stampedBytes);

    // Step 9: Return result
    return {
      stampedPdfBuffer,
      renderedPngWidth: pxWidth,
      renderedPngHeight: pxHeight,
      page: position.page,
    };
  }

  /**
   * Convert a browser canvas Y coordinate to PDF Y coordinate.
   *
   * Browser canvas: origin top-left, Y increases downward
   * PDF:           origin bottom-left, Y increases upward
   *
   * Formula: pdfY = pageHeightPts - (canvasY * pixelsPerPoint) - stampHeightPts
   *
   * @param canvasY - Y from browser (pixels from top of canvas)
   * @param stampHeightPts - Stamp height in PDF points
   * @param pageHeightPts - Page height in PDF points (page.getHeight())
   * @param pixelsPerPoint - Conversion factor. At 96dpi: 72/96 = 0.75. Default: 1.
   * @returns Y coordinate in PDF point space (from bottom of page)
   *
   * @example
   * // Signature captured at Y=200 on a 96dpi canvas, A4 page, 60pt tall stamp
   * const pdfY = VisualStamper.canvasYToPdfY(200, 60, 841.89, 72/96);
   * // pdfY ≈ 841.89 - 150 - 60 = 631.89
   */
  static canvasYToPdfY(
    canvasY: number,
    stampHeightPts: number,
    pageHeightPts: number,
    pixelsPerPoint: number = 1,
  ): number {
    return pageHeightPts - canvasY * pixelsPerPoint - stampHeightPts;
  }
}
