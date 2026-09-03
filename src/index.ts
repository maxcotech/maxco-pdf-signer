export { PdfSigner } from './PdfSigner';
export type {
  LocalSignOptions,
  RemoteSignOptions,
  SignedPdfResult,
  VerificationResult,
  PdfSignerConstructorOptions,
  SigningMetadata,
} from './PdfSigner';
export { VisualStamper } from './visual/VisualStamper';
export type {
  SignatureAppearance,
  StampPosition,
  ResolvedStampPosition,
  StampOrigin,
  StampUnits,
  PageGeometry,
  VisualStampResult,
} from './visual/VisualStamper.types';
export {
  resolveStampPosition,
  canvasYToPdfY,
  normaliseRotation,
} from './visual/coordinates';
export { inspectPdf } from './engine/inspectPdf';
export type { PdfInspection, PdfPageInfo } from './engine/PdfEngine.types';
export type {
  LocalSigningOptions,
  RemoteHsmSigningOptions,
} from './crypto/CryptoStore.types';
export { normaliseP12Bytes } from './utils/certUtils';
export {
  PdfSignerError,
  SignatureOverflowError,
  ByteRangeError,
  InvalidCertificateError,
  InvalidPdfError,
  InvalidAppearanceError,
  InvalidPositionError,
  MissingPositionError,
  HsmTimeoutError,
} from './errors';
