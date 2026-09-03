/**
 * Stamp coordinate resolution.
 *
 * The PDF user space this library draws into has its origin at the BOTTOM-LEFT
 * of the page and measures in points (1/72 inch). Almost every caller, however,
 * obtains a stamp rectangle from a browser: origin TOP-LEFT, measured in CSS
 * pixels, relative to a page rendered at whatever scale fits the viewport.
 *
 * Converting between the two is a two-line calculation that is nevertheless the
 * single most common integration bug — it fails silently, producing a stamp that
 * is merely in the wrong place, so nothing throws and the PDF still validates.
 * Doing it here, once, against the page geometry the stamper has already read,
 * removes it from every caller.
 *
 * The declared `origin` and `units` on a StampPosition say which space the
 * numbers are in; this module maps them into PDF user space.
 */
import { InvalidPositionError } from '../errors';
import type { StampPosition, ResolvedStampPosition, PageGeometry } from './VisualStamper.types';

/**
 * Fractional disagreement tolerated between the horizontal and vertical scales
 * when a caller supplies both viewport dimensions.
 *
 * A viewport produced by a real renderer (pdf.js `page.getViewport({ scale })`,
 * an `<img>` at natural aspect) matches the page aspect ratio exactly, so any
 * meaningful divergence means the caller measured the wrong box — typically the
 * scroll container rather than the rendered page. Catching that here is the
 * difference between a clear error and a stamp misplaced on one axis only.
 */
const SCALE_AGREEMENT_TOLERANCE = 0.02;

/** Normalise an arbitrary PDF /Rotate value to one of 0, 90, 180, 270. */
export function normaliseRotation(angle: number): number {
  return (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
}

/**
 * Map a caller-supplied stamp rectangle into PDF user space (points,
 * bottom-left origin), using the geometry of the page it targets.
 *
 * A position already in the default space (`units: 'pt'`, `origin:
 * 'bottom-left'`) passes through unchanged apart from the bounds check.
 *
 * @throws InvalidPositionError if the rectangle is degenerate, if a pixel
 *   measurement arrives without a viewport dimension to scale it against, if the
 *   two viewport dimensions disagree about the scale, if conversion is requested
 *   for a rotated page, or if the resolved rectangle misses the page entirely.
 */
export function resolveStampPosition(
  position: StampPosition,
  page: PageGeometry,
): ResolvedStampPosition {
  const units = position.units ?? 'pt';
  const origin = position.origin ?? 'bottom-left';

  if (position.width <= 0 || position.height <= 0) {
    throw new InvalidPositionError(
      `Stamp width and height must be > 0, got ${position.width}x${position.height}`,
    );
  }

  const hasViewport =
    position.viewportWidth !== undefined || position.viewportHeight !== undefined;
  if (units !== 'px' && hasViewport) {
    throw new InvalidPositionError(
      'viewportWidth/viewportHeight are only meaningful with units:"px". Set units:"px" if the ' +
        'rectangle was measured in rendered pixels, or drop the viewport fields if it is ' +
        'already in points.',
    );
  }

  // Checked before the scale is derived, so a rotated page reports the problem
  // worth acting on — abandon the conversion entirely — rather than a complaint
  // about the viewport of a conversion that was never going to be attempted.
  //
  // A rotated page displays a different box than the user space it is drawn in,
  // so a top-left or pixel measurement taken over the rendered page cannot be
  // mapped by scale-and-flip alone. Rather than place the stamp somewhere
  // plausible but wrong, say so.
  if ((units === 'px' || origin === 'top-left') && page.rotation !== 0) {
    throw new InvalidPositionError(
      `Page ${position.page} has /Rotate ${page.rotation}, so a "${origin}" / "${units}" ` +
        'rectangle cannot be converted unambiguously. Supply the rectangle in PDF user space ' +
        'instead (units:"pt", origin:"bottom-left") — user space is unaffected by /Rotate.',
    );
  }

  const scale = units === 'px' ? pixelScale(position, page) : 1;

  const width = position.width * scale;
  const height = position.height * scale;
  const x = position.x * scale;
  const yFromDeclaredOrigin = position.y * scale;
  const y =
    origin === 'top-left' ? page.heightPts - yFromDeclaredOrigin - height : yFromDeclaredOrigin;

  const resolved: ResolvedStampPosition = { page: position.page, x, y, width, height };
  assertOnPage(resolved, page, position);
  return resolved;
}

/**
 * Derive points-per-pixel from whichever viewport dimensions the caller gave.
 *
 * Either dimension alone is enough — the scale is uniform — but when both are
 * present they are cross-checked, because agreement is evidence the caller
 * measured the rendered page rather than something around it.
 */
function pixelScale(position: StampPosition, page: PageGeometry): number {
  const { viewportWidth, viewportHeight } = position;

  if (viewportWidth !== undefined && viewportWidth <= 0) {
    throw new InvalidPositionError(`viewportWidth must be > 0, got ${viewportWidth}`);
  }
  if (viewportHeight !== undefined && viewportHeight <= 0) {
    throw new InvalidPositionError(`viewportHeight must be > 0, got ${viewportHeight}`);
  }

  const horizontal = viewportWidth !== undefined ? page.widthPts / viewportWidth : undefined;
  const vertical = viewportHeight !== undefined ? page.heightPts / viewportHeight : undefined;

  if (horizontal === undefined && vertical === undefined) {
    throw new InvalidPositionError(
      'units:"px" requires viewportWidth or viewportHeight — the pixel size of the rendered ' +
        `page the rectangle was measured against. Page ${position.page} is ` +
        `${round(page.widthPts)}x${round(page.heightPts)}pt; if it was rendered 1000px wide, ` +
        'send viewportWidth: 1000.',
    );
  }

  if (horizontal !== undefined && vertical !== undefined) {
    const divergence = Math.abs(horizontal - vertical) / Math.max(horizontal, vertical);
    if (divergence > SCALE_AGREEMENT_TOLERANCE) {
      throw new InvalidPositionError(
        `viewportWidth (${viewportWidth}) and viewportHeight (${viewportHeight}) imply ` +
          `different scales (${horizontal.toFixed(4)} vs ${vertical.toFixed(4)} pt/px) for a ` +
          `${round(page.widthPts)}x${round(page.heightPts)}pt page. The viewport does not match ` +
          'the page aspect ratio — measure the rendered page itself, not its container.',
      );
    }
  }

  return horizontal ?? vertical!;
}

/**
 * Reject a rectangle that lies wholly off the page.
 *
 * Overhanging an edge is legitimate (a stamp deliberately bled past the margin),
 * but a rectangle with no intersection at all draws nothing — the classic
 * signature of an unconverted browser coordinate, and otherwise a completely
 * silent failure.
 */
function assertOnPage(
  resolved: ResolvedStampPosition,
  page: PageGeometry,
  original: StampPosition,
): void {
  const misses =
    resolved.x >= page.widthPts ||
    resolved.y >= page.heightPts ||
    resolved.x + resolved.width <= 0 ||
    resolved.y + resolved.height <= 0;

  if (!misses) return;

  const declared =
    original.units === 'px' || original.origin === 'top-left'
      ? ` (converted from ${original.origin ?? 'bottom-left'}/${original.units ?? 'pt'} ` +
        `${original.x},${original.y} ${original.width}x${original.height})`
      : '';

  throw new InvalidPositionError(
    `Stamp rectangle x=${round(resolved.x)} y=${round(resolved.y)} ` +
      `${round(resolved.width)}x${round(resolved.height)}pt${declared} lies entirely outside ` +
      `page ${resolved.page}, which is ${round(page.widthPts)}x${round(page.heightPts)}pt. ` +
      'Nothing would be drawn. PDF y is measured from the BOTTOM edge upward — if the value came ' +
      'from a browser, send origin:"top-left" (and units:"px" with viewportWidth) and let the ' +
      'conversion happen here.',
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Convert a browser canvas Y coordinate to a PDF Y coordinate.
 *
 * Retained for callers doing the conversion themselves before building a
 * StampPosition. Prefer declaring `origin: 'top-left'` on the position and
 * letting `resolveStampPosition` handle it — that path knows the real page
 * height and validates the result.
 *
 * Formula: pdfY = pageHeightPts - (canvasY * pixelsPerPoint) - stampHeightPts
 *
 * @param canvasY - Y from browser (pixels from top of canvas)
 * @param stampHeightPts - Stamp height in PDF points
 * @param pageHeightPts - Page height in PDF points
 * @param pixelsPerPoint - Conversion factor. At 96dpi: 72/96 = 0.75. Default: 1.
 */
export function canvasYToPdfY(
  canvasY: number,
  stampHeightPts: number,
  pageHeightPts: number,
  pixelsPerPoint = 1,
): number {
  return pageHeightPts - canvasY * pixelsPerPoint - stampHeightPts;
}
