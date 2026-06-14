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
