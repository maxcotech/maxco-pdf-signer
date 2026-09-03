/**
 * Stamp coordinate resolution.
 *
 * The conversion these tests cover fails silently when it is wrong — the stamp
 * simply appears somewhere else — so the assertions are on exact arithmetic
 * rather than on "it did not throw". The end-to-end cases at the bottom prove
 * the resolved rectangle is what actually reaches the drawing call, since a
 * correct resolver wired in at the wrong point would still misplace the stamp.
 */
import fs from 'fs';
import path from 'path';

import { resolveStampPosition, canvasYToPdfY, normaliseRotation } from '../src/visual/coordinates';
import { VisualStamper } from '../src/visual/VisualStamper';
import { InvalidPositionError } from '../src/errors';
import type { PageGeometry, StampPosition } from '../src/visual/VisualStamper.types';

/** US Letter, unrotated — matches test/fixtures/sample.pdf. */
const LETTER: PageGeometry = { widthPts: 612, heightPts: 792, rotation: 0 };
const A4: PageGeometry = { widthPts: 595.28, heightPts: 841.89, rotation: 0 };

const samplePdf = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));

describe('resolveStampPosition', () => {
  describe('default space (points, bottom-left)', () => {
    it('passes a rectangle through unchanged', () => {
      const position: StampPosition = { page: 0, x: 50, y: 40, width: 200, height: 60 };
      expect(resolveStampPosition(position, LETTER)).toEqual({
        page: 0,
        x: 50,
        y: 40,
        width: 200,
        height: 60,
      });
    });

    it('passes through unchanged when the defaults are stated explicitly', () => {
      const position: StampPosition = {
        page: 1,
        x: 50,
        y: 40,
        width: 200,
        height: 60,
        origin: 'bottom-left',
        units: 'pt',
      };
      expect(resolveStampPosition(position, LETTER)).toEqual({
        page: 1,
        x: 50,
        y: 40,
        width: 200,
        height: 60,
      });
    });
  });

  describe('top-left origin', () => {
    it('flips y against the page height, accounting for stamp height', () => {
      // A stamp whose TOP edge is 100pt below the top of a 792pt page has its
      // BOTTOM edge at 792 - 100 - 60 = 632pt above the bottom.
      const resolved = resolveStampPosition(
        { page: 0, x: 50, y: 100, width: 200, height: 60, origin: 'top-left' },
        LETTER,
      );
      expect(resolved).toEqual({ page: 0, x: 50, y: 632, width: 200, height: 60 });
    });

    it('leaves x untouched — only the vertical axis differs between the two spaces', () => {
      const resolved = resolveStampPosition(
        { page: 0, x: 123.5, y: 0, width: 100, height: 50, origin: 'top-left' },
        LETTER,
      );
      expect(resolved.x).toBe(123.5);
      // y: 0 from the top means the stamp is flush with the top edge.
      expect(resolved.y).toBe(792 - 50);
    });

    it('round-trips against canvasYToPdfY, which does the same flip by hand', () => {
      const resolved = resolveStampPosition(
        { page: 0, x: 0, y: 200, width: 100, height: 60, origin: 'top-left' },
        A4,
      );
      expect(resolved.y).toBeCloseTo(canvasYToPdfY(200, 60, A4.heightPts, 1), 6);
    });
  });

  describe('pixel units', () => {
    it('scales by the page-width-to-viewport ratio', () => {
      // A 612pt page rendered 1224px wide is exactly 2px per point.
      const resolved = resolveStampPosition(
        {
          page: 0,
          x: 200,
          y: 100,
          width: 400,
          height: 120,
          units: 'px',
          viewportWidth: 1224,
        },
        LETTER,
      );
      expect(resolved).toEqual({ page: 0, x: 100, y: 50, width: 200, height: 60 });
    });

    it('accepts viewportHeight instead of viewportWidth', () => {
      const resolved = resolveStampPosition(
        { page: 0, x: 200, y: 100, width: 400, height: 120, units: 'px', viewportHeight: 1584 },
        LETTER,
      );
      expect(resolved).toEqual({ page: 0, x: 100, y: 50, width: 200, height: 60 });
    });

    it('handles the browser case: top-left pixels over a rendered page', () => {
      // The realistic integration: a box dragged over a page rendered 1000px
      // wide. Scale is 612/1000 = 0.612 pt/px.
      const resolved = resolveStampPosition(
        {
          page: 0,
          x: 100,
          y: 200,
          width: 300,
          height: 90,
          origin: 'top-left',
          units: 'px',
          viewportWidth: 1000,
        },
        LETTER,
      );
      const scale = 612 / 1000;
      expect(resolved.x).toBeCloseTo(100 * scale, 6);
      expect(resolved.width).toBeCloseTo(300 * scale, 6);
      expect(resolved.height).toBeCloseTo(90 * scale, 6);
      // y flips: page height minus the scaled distance from the top, minus the
      // scaled stamp height.
      expect(resolved.y).toBeCloseTo(792 - 200 * scale - 90 * scale, 6);
    });

    it('tolerates viewport dimensions that agree on the scale', () => {
      // 1000 x 1294 is within 2% of the Letter aspect ratio (1000 x 1294.1).
      expect(() =>
        resolveStampPosition(
          {
            page: 0,
            x: 10,
            y: 10,
            width: 100,
            height: 50,
            units: 'px',
            viewportWidth: 1000,
            viewportHeight: 1294,
          },
          LETTER,
        ),
      ).not.toThrow();
    });

    it('rejects viewport dimensions that disagree — the wrong box was measured', () => {
      expect(() =>
        resolveStampPosition(
          {
            page: 0,
            x: 10,
            y: 10,
            width: 100,
            height: 50,
            units: 'px',
            viewportWidth: 1000,
            viewportHeight: 800,
          },
          LETTER,
        ),
      ).toThrow(/different scales/);
    });

    it('rejects px units with no viewport to scale against', () => {
      expect(() =>
        resolveStampPosition(
          { page: 0, x: 10, y: 10, width: 100, height: 50, units: 'px' },
          LETTER,
        ),
      ).toThrow(InvalidPositionError);
    });

    it('rejects a non-positive viewport dimension', () => {
      expect(() =>
        resolveStampPosition(
          { page: 0, x: 10, y: 10, width: 100, height: 50, units: 'px', viewportWidth: 0 },
          LETTER,
        ),
      ).toThrow(/viewportWidth must be > 0/);
    });

    it('rejects viewport fields sent with point units', () => {
      expect(() =>
        resolveStampPosition(
          { page: 0, x: 10, y: 10, width: 100, height: 50, viewportWidth: 1000 },
          LETTER,
        ),
      ).toThrow(/only meaningful with units:"px"/);
    });
  });

  describe('rotated pages', () => {
    const rotated: PageGeometry = { widthPts: 612, heightPts: 792, rotation: 90 };

    it('still passes user-space points through — /Rotate does not affect that space', () => {
      const resolved = resolveStampPosition(
        { page: 0, x: 50, y: 40, width: 200, height: 60 },
        rotated,
      );
      expect(resolved).toEqual({ page: 0, x: 50, y: 40, width: 200, height: 60 });
    });

    it('refuses to convert a top-left rectangle rather than guessing', () => {
      expect(() =>
        resolveStampPosition(
          { page: 0, x: 50, y: 40, width: 200, height: 60, origin: 'top-left' },
          rotated,
        ),
      ).toThrow(/\/Rotate 90/);
    });

    it('refuses to convert a pixel rectangle', () => {
      expect(() =>
        resolveStampPosition(
          {
            page: 0,
            x: 50,
            y: 40,
            width: 200,
            height: 60,
            units: 'px',
            viewportWidth: 1000,
          },
          rotated,
        ),
      ).toThrow(InvalidPositionError);
    });
  });

  describe('guardrails', () => {
    it('rejects a degenerate rectangle', () => {
      expect(() =>
        resolveStampPosition({ page: 0, x: 0, y: 0, width: 0, height: 50 }, LETTER),
      ).toThrow(/must be > 0/);
    });

    it('rejects a rectangle that misses the page entirely', () => {
      // The classic unconverted browser coordinate: y measured from the top,
      // sent as if it were measured from the bottom, on a tall page.
      expect(() =>
        resolveStampPosition({ page: 0, x: 50, y: 2000, width: 200, height: 60 }, LETTER),
      ).toThrow(/lies entirely outside/);
    });

    it('names the pre-conversion values when reporting an off-page rectangle', () => {
      expect(() =>
        resolveStampPosition(
          {
            page: 0,
            x: 5000,
            y: 10,
            width: 200,
            height: 60,
            origin: 'top-left',
            units: 'px',
            viewportWidth: 1000,
          },
          LETTER,
        ),
      ).toThrow(/converted from top-left\/px/);
    });

    it('allows a rectangle that merely overhangs an edge', () => {
      // Deliberate bleed past the right margin is legitimate.
      expect(() =>
        resolveStampPosition({ page: 0, x: 550, y: 40, width: 200, height: 60 }, LETTER),
      ).not.toThrow();
    });
  });
});

describe('normaliseRotation', () => {
  it.each([
    [0, 0],
    [90, 90],
    [180, 180],
    [270, 270],
    [360, 0],
    [-90, 270],
    [450, 90],
    [89, 90],
  ])('maps %i to %i', (input, expected) => {
    expect(normaliseRotation(input)).toBe(expected);
  });
});

describe('VisualStamper integration', () => {
  const stamper = new VisualStamper();
  const appearance = { text: 'Jane Smith' };

  it('reports the resolved rectangle and page geometry it drew against', async () => {
    const result = await stamper.applyStamp(samplePdf(), appearance, {
      page: 0,
      x: 100,
      y: 200,
      width: 300,
      height: 90,
      origin: 'top-left',
      units: 'px',
      viewportWidth: 1000,
    });

    const scale = 612 / 1000;
    expect(result.pageGeometry).toEqual({ widthPts: 612, heightPts: 792, rotation: 0 });
    expect(result.resolvedPosition.x).toBeCloseTo(100 * scale, 6);
    expect(result.resolvedPosition.y).toBeCloseTo(792 - 200 * scale - 90 * scale, 6);
    expect(result.resolvedPosition.width).toBeCloseTo(300 * scale, 6);
  });

  it('rasterises the PNG at the RESOLVED size, not the requested pixel size', async () => {
    // Rasterising at the raw px numbers would produce a needlessly huge image
    // for a large viewport and a blurry one for a small viewport. The PNG must
    // track the resolved point dimensions times renderScale.
    const result = await stamper.applyStamp(samplePdf(), appearance, {
      page: 0,
      x: 100,
      y: 200,
      width: 400,
      height: 120,
      origin: 'top-left',
      units: 'px',
      viewportWidth: 1224, // exactly 2px per point
    });

    // 400px / 2 = 200pt wide, at the default renderScale of 2 → 400px PNG.
    expect(result.renderedPngWidth).toBe(400);
    expect(result.renderedPngHeight).toBe(120);
  });

  it('places a point rectangle exactly where it was asked to', async () => {
    const result = await stamper.applyStamp(samplePdf(), appearance, {
      page: 0,
      x: 50,
      y: 40,
      width: 200,
      height: 60,
    });
    expect(result.resolvedPosition).toEqual({
      page: 0,
      x: 50,
      y: 40,
      width: 200,
      height: 60,
    });
  });

  it('rejects an off-page rectangle instead of silently drawing nothing', async () => {
    await expect(
      stamper.applyStamp(samplePdf(), appearance, {
        page: 0,
        x: 50,
        y: 5000,
        width: 200,
        height: 60,
      }),
    ).rejects.toThrow(InvalidPositionError);
  });
});
