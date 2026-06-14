/**
 * Defines the position and size of the signature stamp on a PDF page.
 * All values are in PDF user-space points (1 point = 1/72 inch).
 * Origin (0, 0) is the BOTTOM-LEFT corner of the page (PDF convention).
 *
 * WARNING: Browser canvas and CSS use top-left origin with Y increasing downward.
 * Use VisualStamper.canvasYToPdfY() to convert from browser coordinates.
 */
export interface StampPosition {
  /** Page index, 0-based. 0 = first page. */
  page: number;
  /** X coordinate of stamp bottom-left corner, in points from left edge */
  x: number;
  /** Y coordinate of stamp bottom-left corner, in points from bottom edge */
  y: number;
  /** Width of the stamp in points */
  width: number;
  /** Height of the stamp in points */
  height: number;
}

/**
 * Defines the visual appearance of the signature stamp.
 * Provide exactly one of `svgString` or `text`.
 */
export interface SignatureAppearance {
  /**
   * A complete SVG document string. Must include a `viewBox` attribute.
   * Will be rasterised to PNG at (width * renderScale) x (height * renderScale) pixels,
   * then embedded in the PDF at the exact stamp dimensions.
   *
   * Example (captured from HTML canvas):
   *   '<svg viewBox="0 0 300 80" xmlns="http://www.w3.org/2000/svg">
   *     <path d="M10,60 C40,10 80,10 120,60" stroke="#000" fill="none" stroke-width="2"/>
   *   </svg>'
   */
  svgString?: string;

  /**
   * A text string rendered in a bundled script/cursive font (Great Vibes).
   * Internally converted to SVG then rasterised — same pipeline as svgString.
   */
  text?: string;

  /** Font size for text-mode rendering, in SVG user units. Default: 32. */
  fontSize?: number;

  /** CSS color string for text rendering. Default: '#1a1a2e'. Ignored for svgString. */
  color?: string;

  /**
   * Pixel scale factor for rasterisation. Default: 2 (renders at 2x stamp size for crispness).
   * Increase to 3 for very small stamps. Values above 4 are excessive.
   */
  renderScale?: number;
}

export interface VisualStampResult {
  /** PDF buffer after stamping but before cryptographic signing */
  stampedPdfBuffer: Buffer;
  /** Actual pixel width of the PNG embedded into the PDF */
  renderedPngWidth: number;
  /** Actual pixel height of the PNG embedded into the PDF */
  renderedPngHeight: number;
  /** Page index the stamp was applied to */
  page: number;
}
