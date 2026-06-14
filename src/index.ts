export { PdfSigner } from './PdfSigner';
export type {
  LocalSignOptions,
  RemoteSignOptions,
  SignedPdfResult,
  VerificationResult,
  PdfSignerConstructorOptions,
  SigningMetadata,
} from './PdfSigner';
export type {
  SignatureAppearance,
  StampPosition,
  VisualStampResult,
} from './visual/VisualStamper.types';
export type {
  LocalSigningOptions,
  RemoteHsmSigningOptions,
} from './crypto/CryptoStore.types';
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
