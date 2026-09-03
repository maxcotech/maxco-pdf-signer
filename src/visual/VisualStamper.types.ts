/** Which page corner `StampPosition.y` is measured from. */
export type StampOrigin =
  /** PDF convention: y measured upward from the bottom edge. Default. */
  | 'bottom-left'
  /** Browser/CSS convention: y measured downward from the top edge. */
  | 'top-left';

/** The unit `StampPosition` values are expressed in. */
export type StampUnits =
  /** PDF points, 1/72 inch. Default. */
  | 'pt'
  /** Pixels of a rendered page. Requires viewportWidth or viewportHeight. */
  | 'px';

/**
 * Geometry of the page a stamp targets, as read from the document.
 * `widthPts`/`heightPts` are user-space (MediaBox) dimensions — the space stamp
 * coordinates live in, which is unaffected by /Rotate.
 */
export interface PageGeometry {
  widthPts: number;
  heightPts: number;
  /** Normalised /Rotate value: 0, 90, 180 or 270. */
  rotation: number;
}

/**
 * Defines the position and size of the signature stamp on a PDF page.
 *
 * By default all values are in PDF user-space points (1 point = 1/72 inch) with
 * origin (0, 0) at the BOTTOM-LEFT corner of the page — the PDF convention.
 *
 * Browsers use the opposite vertical convention and measure in pixels of a page
 * rendered at some scale. Rather than converting before calling, declare the
 * space the numbers are in with `origin` and `units` and the conversion is done
 * here, against the real page dimensions:
 *
 * ```typescript
 * // Rectangle dragged over a page rendered 1000px wide in a browser
 * position: {
 *   page: 0, x: 120, y: 80, width: 200, height: 60,
 *   origin: 'top-left', units: 'px', viewportWidth: 1000,
 * }
 * ```
 */
export interface StampPosition {
  /** Page index, 0-based. 0 = first page. */
  page: number;
  /** X coordinate of the stamp's near-left edge, from the left page edge. */
  x: number;
  /** Y coordinate of the stamp's edge nearest `origin`, from that page edge. */
  y: number;
  /** Width of the stamp. */
  width: number;
  /** Height of the stamp. */
  height: number;

  /**
   * Corner `y` is measured from. Default 'bottom-left' (PDF convention).
   * Set 'top-left' for a value taken from a browser or canvas.
   *
   * Cannot be converted on a page with a non-zero /Rotate — supply user-space
   * points for those.
   */
  origin?: StampOrigin;

  /**
   * Unit of x/y/width/height. Default 'pt'.
   *
   * 'px' means pixels of a rendered page and requires `viewportWidth` or
   * `viewportHeight` to establish the scale. Cannot be converted on a page with
   * a non-zero /Rotate.
   */
  units?: StampUnits;

  /**
   * Pixel width of the rendered page the rectangle was measured against — e.g.
   * `page.getViewport({ scale }).width` from pdf.js, or the rendered canvas
   * width. Only valid with `units: 'px'`.
   */
  viewportWidth?: number;

  /**
   * Pixel height of the rendered page the rectangle was measured against.
   * Interchangeable with `viewportWidth`; when both are given they are
   * cross-checked against the page aspect ratio. Only valid with `units: 'px'`.
   */
  viewportHeight?: number;
}

/**
 * A stamp rectangle mapped into PDF user space: always points, always
 * bottom-left origin. Produced by `resolveStampPosition`.
 */
export interface ResolvedStampPosition {
  page: number;
  x: number;
  y: number;
  width: number;
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
  /**
   * The rectangle actually drawn, in PDF user-space points with bottom-left
   * origin, after any origin/units conversion. Equal to the supplied position
   * when it was already in that space. Surface this to callers who sent browser
   * coordinates so they can confirm where the stamp landed.
   */
  resolvedPosition: ResolvedStampPosition;
  /** Geometry of the page the stamp was drawn on. */
  pageGeometry: PageGeometry;
  /** Actual pixel width of the PNG embedded into the PDF */
  renderedPngWidth: number;
  /** Actual pixel height of the PNG embedded into the PDF */
  renderedPngHeight: number;
  /** Page index the stamp was applied to */
  page: number;
}
