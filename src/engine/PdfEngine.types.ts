export interface SignaturePlaceholderOptions {
  placeholderSize?: number; // bytes; default 16384
  reason?: string;
  location?: string;
  contactInfo?: string;
  name?: string;
  signingDate?: Date;
  subFilter?: 'adbe.pkcs7.detached' | 'ETSI.CAdES.detached';
}

export interface ByteRange {
  offset1: number; // always 0
  length1: number; // bytes up to (not including) the '<' before /Contents hex value
  offset2: number; // first byte after the /Contents hex value closing '>'
  length2: number; // bytes from offset2 to end of file
}

export interface PreparedPdf {
  pdfBuffer: Buffer;
  byteRange: ByteRange;
  contentsOffset: number; // index of first hex char in /Contents
  contentsLength: number; // total hex chars allocated (= placeholderSize * 2)
}

/** Geometry of one page, as reported by `inspectPdf`. */
export interface PdfPageInfo {
  /** 0-based page index — the value a StampPosition.page takes. */
  index: number;
  /**
   * Page width in points in PDF user space (MediaBox). Stamp coordinates are in
   * this space, so this is the number stamp arithmetic uses.
   */
  widthPts: number;
  /** Page height in points in PDF user space (MediaBox). */
  heightPts: number;
  /** Normalised /Rotate value: 0, 90, 180 or 270. */
  rotation: number;
  /**
   * Width of the box a viewer displays — swapped with the height when
   * `rotation` is 90 or 270. A pixel rectangle measured over a rendered page is
   * relative to the display box, not the MediaBox.
   */
  displayWidthPts: number;
  /** Height of the box a viewer displays. See `displayWidthPts`. */
  displayHeightPts: number;
}

/** Everything `inspectPdf` can determine about a document without modifying it. */
export interface PdfInspection {
  /** Size of the inspected buffer in bytes. */
  sizeBytes: number;
  /** Number of pages. 0 when the document is encrypted and could not be read. */
  pageCount: number;
  /** Per-page geometry. Empty when the document is encrypted. */
  pages: PdfPageInfo[];
  /**
   * True when the document is encrypted. This library cannot sign an encrypted
   * PDF, so this is reported rather than thrown — the caller needs the fact in
   * order to explain the rejection.
   */
  encrypted: boolean;
  /**
   * Number of existing signature dictionaries found, counted by /ByteRange
   * entries across the whole file including earlier incremental revisions.
   * Non-zero means the document has been signed before; signing again is
   * legitimate but is rarely what an app handling a fresh upload intends.
   */
  signatureCount: number;
  /** Whether this document can be submitted for signing as-is. */
  signable: boolean;
}
