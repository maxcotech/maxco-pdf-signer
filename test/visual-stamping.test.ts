import * as fs from 'fs';
import * as path from 'path';
import { VisualStamper } from '../src/visual/VisualStamper';
import { InvalidAppearanceError, InvalidPositionError } from '../src/errors';

const FIXTURES = path.join(__dirname, 'fixtures');
const OUTPUT = path.join(__dirname, 'output');

let samplePdfBuffer: Buffer;
let sampleSvgString: string;

beforeAll(() => {
  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

  const pdfPath = path.join(FIXTURES, 'sample.pdf');
  if (!fs.existsSync(pdfPath)) {
    throw new Error(
      `test/fixtures/sample.pdf not found. Run: bash scripts/setup-test-env.sh`,
    );
  }
  samplePdfBuffer = fs.readFileSync(pdfPath);
  sampleSvgString = fs.readFileSync(path.join(FIXTURES, 'sample-signature.svg'), 'utf8');
});

describe('VisualStamper', () => {
  const stamper = new VisualStamper();

  test('applies SVG stamp — output PDF is larger and contains embedded XObject image', async () => {
    const result = await stamper.applyStamp(
      samplePdfBuffer,
      { svgString: sampleSvgString },
      { page: 0, x: 50, y: 50, width: 200, height: 60 },
    );

    expect(result.stampedPdfBuffer.length).toBeGreaterThan(samplePdfBuffer.length);
    expect(result.page).toBe(0);
    expect(result.renderedPngWidth).toBeGreaterThan(0);
    expect(result.renderedPngHeight).toBeGreaterThan(0);

    // Should contain embedded image resources (XObject)
    const pdfStr = result.stampedPdfBuffer.toString('binary');
    const hasXObject = pdfStr.includes('/XObject') || pdfStr.includes('XObject');
    expect(hasXObject).toBe(true);

    fs.writeFileSync(path.join(OUTPUT, 'visual-svg-stamp.pdf'), result.stampedPdfBuffer);
  });

  test('applies text stamp with bundled/fallback font', async () => {
    const result = await stamper.applyStamp(
      samplePdfBuffer,
      { text: 'Jane Smith', fontSize: 36, color: '#1a1a2e' },
      { page: 0, x: 80, y: 100, width: 220, height: 70 },
    );

    expect(result.stampedPdfBuffer.length).toBeGreaterThan(samplePdfBuffer.length);
    expect(result.renderedPngWidth).toBe(440); // 220 * renderScale(2)
    expect(result.renderedPngHeight).toBe(140); // 70 * renderScale(2)

    fs.writeFileSync(path.join(OUTPUT, 'visual-text-stamp.pdf'), result.stampedPdfBuffer);
  });

  test('throws InvalidAppearanceError when neither svgString nor text is provided', async () => {
    await expect(
      stamper.applyStamp(
        samplePdfBuffer,
        {},
        { page: 0, x: 0, y: 0, width: 100, height: 50 },
      ),
    ).rejects.toThrow(InvalidAppearanceError);
  });

  test('throws InvalidAppearanceError when both svgString and text are provided', async () => {
    await expect(
      stamper.applyStamp(
        samplePdfBuffer,
        { svgString: sampleSvgString, text: 'Also text' },
        { page: 0, x: 0, y: 0, width: 100, height: 50 },
      ),
    ).rejects.toThrow(InvalidAppearanceError);
  });

  test('throws InvalidPositionError when page index is out of range', async () => {
    await expect(
      stamper.applyStamp(
        samplePdfBuffer,
        { svgString: sampleSvgString },
        { page: 999, x: 0, y: 0, width: 100, height: 50 },
      ),
    ).rejects.toThrow(InvalidPositionError);
  });

  test('throws InvalidPositionError when width is <= 0', async () => {
    await expect(
      stamper.applyStamp(
        samplePdfBuffer,
        { svgString: sampleSvgString },
        { page: 0, x: 0, y: 0, width: 0, height: 50 },
      ),
    ).rejects.toThrow(InvalidPositionError);
  });

  test('throws InvalidPositionError when height is <= 0', async () => {
    await expect(
      stamper.applyStamp(
        samplePdfBuffer,
        { svgString: sampleSvgString },
        { page: 0, x: 0, y: 0, width: 100, height: -1 },
      ),
    ).rejects.toThrow(InvalidPositionError);
  });

  test('canvasYToPdfY inverts Y axis correctly for A4 page', () => {
    // A4 height = 841.89pts, stamp height = 60pts, canvas Y = 200, 96dpi → pts = 200*0.75=150
    const pdfY = VisualStamper.canvasYToPdfY(200, 60, 841.89, 72 / 96);
    expect(pdfY).toBeCloseTo(841.89 - 150 - 60, 1);
  });

  test('canvasYToPdfY with default pixelsPerPoint = 1', () => {
    const pdfY = VisualStamper.canvasYToPdfY(100, 50, 792);
    expect(pdfY).toBe(792 - 100 - 50);
  });

  test('stamped PDF does not contain /ObjStm (useObjectStreams:false enforced)', async () => {
    const result = await stamper.applyStamp(
      samplePdfBuffer,
      { svgString: sampleSvgString },
      { page: 0, x: 50, y: 50, width: 200, height: 60 },
    );

    const pdfStr = result.stampedPdfBuffer.toString('binary');
    expect(pdfStr).not.toContain('/ObjStm');
  });

  test('PNG embedded in PDF has no alpha channel (white background applied)', async () => {
    const { rasteriseSvgToPng } = await import('../src/visual/svgToPdf');
    const png = await rasteriseSvgToPng(sampleSvgString, 200, 60);

    // PNG with no alpha channel: color type byte in IHDR is 2 (RGB) not 6 (RGBA)
    // IHDR chunk starts at byte 8, data at byte 16: width(4)+height(4)+bitdepth(1)+colortype(1)
    // PNG magic: 8 bytes, then IHDR: length(4)+type(4)+data...
    // colorType byte is at offset 8+4+4+4+4+1 = 25
    const colorTypeByte = png[25];
    // 2 = Truecolor (RGB), 6 = Truecolor with alpha (RGBA)
    expect(colorTypeByte).toBe(2); // no alpha channel
  });
});
