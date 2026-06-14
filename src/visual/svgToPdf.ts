// VERIFICATION: pipe rasteriseSvgToPng output through `file -` — must report "PNG image data"
// with no alpha channel (bit depth: 8, color type: 2 = RGB).

import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Rasterise an SVG string to a PNG buffer at the specified pixel dimensions.
 *
 * Pipeline:
 *   1. Resvg renders the SVG at native viewBox resolution
 *   2. sharp resizes to the target pixel dimensions
 *   3. sharp flattens alpha channel to white (required for reliable PDF viewer rendering)
 *   4. Returns a PNG buffer with no alpha channel
 *
 * @param svgString - Complete SVG document with a defined viewBox
 * @param outputWidthPx - Target PNG width in pixels
 * @param outputHeightPx - Target PNG height in pixels
 * @returns PNG buffer, no alpha channel, white background
 */
export async function rasteriseSvgToPng(
  svgString: string,
  outputWidthPx: number,
  outputHeightPx: number,
): Promise<Buffer> {
  if (outputWidthPx <= 0 || outputHeightPx <= 0) {
    throw new Error(`Invalid output dimensions: ${outputWidthPx}x${outputHeightPx}`);
  }

  const opts: ResvgRenderOptions = {
    fitTo: {
      mode: 'width',
      value: outputWidthPx,
    },
    background: 'white',
  };

  // Step 1: Render SVG to PNG using resvg (Rust-backed, no browser required)
  const resvg = new Resvg(svgString, opts);
  const rendered = resvg.render();
  const initialPng = rendered.asPng();

  // Step 2 & 3: Resize to exact target dimensions and flatten alpha to white background
  const finalPng = await sharp(initialPng)
    .resize(outputWidthPx, outputHeightPx, {
      fit: 'fill', // exact dimensions, no aspect ratio constraint
      kernel: sharp.kernel.lanczos3,
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } }) // remove alpha channel
    .png({ compressionLevel: 6 })
    .toBuffer();

  return finalPng;
}

/**
 * Build a self-contained SVG document from a plain text string.
 *
 * The font (Great Vibes) is loaded from src/visual/fonts/GreatVibes-Regular.woff2 if present,
 * and inlined as a data-URI @font-face declaration. Falls back to a generic serif font
 * with a styled tspan if the font file is not found.
 *
 * viewBox width heuristic: fontSize * text.length * 0.55 + 2 * paddingPx
 * viewBox height: fontSize * 1.4 (accommodates ascenders and descenders)
 *
 * @param text - Signature text (e.g. signer name)
 * @param fontSize - Font size in SVG user units
 * @param color - CSS color string
 * @returns Complete self-contained SVG string
 */
export function generateTextSignatureSvg(text: string, fontSize: number, color: string): string {
  const paddingPx = 8;
  const viewBoxWidth = Math.ceil(fontSize * text.length * 0.55 + 2 * paddingPx);
  const viewBoxHeight = Math.ceil(fontSize * 1.4);
  const textY = Math.ceil(fontSize * 1.1); // baseline position

  // Try to load the bundled Great Vibes font
  let fontFaceDecl = '';
  let fontFamily = 'Georgia, serif';

  try {
    const fontPath = path.join(__dirname, 'fonts', 'GreatVibes-Regular.woff2');
    if (fs.existsSync(fontPath)) {
      const fontBytes = fs.readFileSync(fontPath);
      const fontB64 = fontBytes.toString('base64');
      fontFamily = 'GreatVibes, cursive';
      fontFaceDecl = `
  <defs>
    <style>
      @font-face {
        font-family: 'GreatVibes';
        src: url('data:font/woff2;base64,${fontB64}') format('woff2');
        font-weight: normal;
        font-style: normal;
      }
    </style>
  </defs>`;
    }
  } catch {
    // Font load failed — use fallback
  }

  // Escape XML special characters in the text
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  // Use single-quoted font-family to avoid XML entity encoding issues with resvg parser
  const safeFontFamily = fontFamily.replace(/"/g, "'");

  return (
    `<svg viewBox="0 0 ${viewBoxWidth} ${viewBoxHeight}" ` +
    `xmlns="http://www.w3.org/2000/svg">` +
    fontFaceDecl +
    `<text ` +
    `x="${paddingPx}" ` +
    `y="${textY}" ` +
    `font-family="${safeFontFamily}" ` +
    `font-size="${fontSize}" ` +
    `fill="${color}"` +
    `>${escaped}</text>` +
    `</svg>`
  );
}
