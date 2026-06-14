# CLAUDE.md — pdf-signer

> **For Claude agents**: This file is your complete operating manual for the pdf-signer library. Read it fully before making any change. Every section is load-bearing; the system has invariants that, when violated, produce signatures that Adobe silently rejects without error. The constraints documented here were discovered against the ISO 32000-1 and RFC 5652 specifications — not convention.

---

## Table of Contents

1. [Project Purpose](#1-project-purpose)
2. [Architecture at a Glance](#2-architecture-at-a-glance)
3. [The Mandatory Two-Phase Pipeline](#3-the-mandatory-two-phase-pipeline)
4. [Directory Map](#4-directory-map)
5. [Module Reference](#5-module-reference)
6. [Public API Surface](#6-public-api-surface)
7. [Critical Invariants (Never Break These)](#7-critical-invariants-never-break-these)
8. [Error Hierarchy](#8-error-hierarchy)
9. [Testing Strategy](#9-testing-strategy)
10. [Development Workflow](#10-development-workflow)
11. [Implementing New Features](#11-implementing-new-features)
12. [Standards & Specification Map](#12-standards--specification-map)
13. [Common Pitfalls](#13-common-pitfalls)

---

## 1. Project Purpose

**pdf-signer** is a Node.js/TypeScript library that produces Adobe-recognized digitally signed PDFs. It combines:

- **Visual signature stamps** — SVG or text rendered to PNG and embedded as an XObject image inside the PDF page
- **Cryptographic PKCS#7/CMS signatures** — a detached SignedData container written into the PDF `/Contents` slot, covering the stamp pixels and the entire document

Two signing paths are supported:

| Path | Certificate source | Private key lives |
|------|--------------------|-------------------|
| **Local (Path A)** | PKCS#12 (.p12/.pfx) file or buffer | In process (node-forge) |
| **Remote HSM (Path B)** | PEM or DER certificate provided separately | In Cloud KMS / HSM (never leaves) |

The result is a PDF that validates as "signature valid, document not modified" in Adobe Acrobat Reader when opened.

---

## 2. Architecture at a Glance

```
PdfSigner (src/PdfSigner.ts)          ← public API, enforces phase order
 ├─ VisualStamper (src/visual/)        ← Phase 1: stamp → PNG → embed
 │   ├─ svgToPdf.ts                    ← SVG rasterisation (resvg + sharp)
 │   └─ VisualStamper.types.ts
 └─ CryptoStore (src/crypto/)          ← Phase 2: hash → sign → inject
     ├─ pkcs7Builder.ts                ← PKCS#7 DER assembly (RFC 5652)
     ├─ CryptoStore.types.ts
     └─ PdfEngine (src/engine/)        ← ByteRange, AcroForm, incremental update
         ├─ PdfEngine.ts
         └─ PdfEngine.types.ts

src/utils/
  ├─ asn1Utils.ts      ← DER tag/length encoding (ITU-T X.690)
  ├─ certUtils.ts      ← P12, PEM, DER certificate parsing
  └─ bufferUtils.ts    ← in-place buffer writes, hex utilities

src/errors.ts          ← error class hierarchy (9 typed errors)
src/index.ts           ← single export point
```

**Data flow direction**: `PdfSigner → VisualStamper → CryptoStore → PdfEngine → pkcs7Builder`

No module calls back upward. Errors propagate as typed subclasses of `PdfSignerError`.

---

## 3. The Mandatory Two-Phase Pipeline

This is the most important concept in the codebase. **Phase order is not a design preference — it is a cryptographic requirement.**

```
Input PDF
    │
    ▼  ── PHASE 1 ──────────────────────────────────────────────────────
VisualStamper.applyStamp()
    • Resolve SVG (svgString as-is, or generate from text with Great Vibes font)
    • rasteriseSvgToPng(): Resvg renders SVG → sharp resizes + flattens alpha → PNG
    • PDFDocument.load() → embedPng() → page.drawImage()
    • pdfDoc.save({ useObjectStreams: false })      ← MANDATORY, see §7
    │
    ▼ Stamped PDF bytes (stamp pixels are now concrete committed bytes)
    │
    ▼  ── PHASE 2 ──────────────────────────────────────────────────────
PdfEngine.preparePdfForSigning()
    • Ensure AcroForm + create signature widget annotation
    • Serialize base PDF (useObjectStreams: false)
    • Append raw incremental update:
        Sig dict  — /ByteRange [placeholder] /Contents <zeros>
        Widget    — updated with /V → Sig dict ref
        xref      — new objects only
        trailer   — /Prev → previous startxref
    • Locate /ByteRange and /Contents tokens in buffer
    • Compute ByteRange arithmetic, assert invariant
    • Write ByteRange in-place (same 45-char width, no resize)
    │
    ▼ PreparedPdf: pdfBuffer with real ByteRange + zero /Contents slot
    │
    ▼
PdfEngine.extractSignableBytes()
    • segment1 = pdfBuffer[0 .. length1-1]
    • segment2 = pdfBuffer[offset2 .. offset2+length2-1]
    • ← stamp PNG bytes ARE in segment1 — covered by the hash
    │
    ▼
SHA-256(segment1 + segment2) → documentHash
    │
    ├─[Path A] buildPkcs7Local()
    │   • buildSignedAttributes(documentHash, time) → {signingForm (0x31), containerForm (0xA0)}
    │   • forge SHA-256(signingForm) → RSA sign with private key → signatureBytes
    │   • assemblePkcs7(signatureBytes, containerForm, certs) → PKCS#7 DER
    │
    └─[Path B] buildPkcs7Remote()
        • buildSignedAttributes() → {signingForm, containerForm}
        • Promise.race([hsmSignFunction(signingForm), timeoutPromise]) → signatureBytes
        • assemblePkcs7(signatureBytes, containerForm, certs) → PKCS#7 DER
    │
    ▼
PdfEngine.injectSignature()
    • pkcs7Hex.padEnd(contentsLength, '0')
    • writeAsciiInPlace() into /Contents slot ← NEVER Buffer.concat
    │
    ▼
SignedPdfResult { signedPdf, documentHash, pkcs7Hex, byteRange, signingTime }
```

### Why Phase Order Cannot Be Reversed

The PKCS#7 signature covers every byte in the document **except** the `/Contents` hex value. If the visual stamp were applied *after* signing:

- The stamp PNG bytes would not exist when the hash was computed
- The stamp pixels would be **outside** the ByteRange
- Adobe Acrobat Reader would show: **"The document has been modified after the signature was applied."**

`PdfSigner.signLocal()` and `PdfSigner.signRemote()` enforce this order. Do not expose any API that allows callers to control phase order.

---

## 4. Directory Map

```
pdf-signer/
├── src/
│   ├── index.ts                      public exports (re-exports only)
│   ├── errors.ts                     9 typed error classes
│   ├── PdfSigner.ts                  main public class
│   ├── crypto/
│   │   ├── CryptoStore.ts            signing orchestration
│   │   ├── CryptoStore.types.ts      LocalSigningOptions, RemoteHsmSigningOptions, SignedPdfResult
│   │   └── pkcs7Builder.ts           PKCS#7 DER assembly from scratch (RFC 5652)
│   ├── engine/
│   │   ├── PdfEngine.ts              AcroForm, ByteRange, incremental update, injection
│   │   └── PdfEngine.types.ts        PreparedPdf, ByteRange, SignaturePlaceholderOptions
│   ├── utils/
│   │   ├── asn1Utils.ts              DER primitives (TAG constants + encode functions)
│   │   ├── bufferUtils.ts            writeAsciiInPlace, findPattern, stringToPdfHex
│   │   └── certUtils.ts             parseP12, parsePemCertificates, getIssuerDer
│   └── visual/
│       ├── VisualStamper.ts          applyStamp, canvasYToPdfY
│       ├── VisualStamper.types.ts    SignatureAppearance, StampPosition, VisualStampResult
│       ├── svgToPdf.ts               rasteriseSvgToPng, generateTextSignatureSvg
│       └── fonts/
│           └── GreatVibes-Regular.woff2   bundled handwriting font (optional, falls back to Georgia)
├── test/
│   ├── local-signing.test.ts
│   ├── remote-hsm.test.ts
│   ├── pkcs7.test.ts
│   ├── visual-stamping.test.ts
│   └── fixtures/                    generated by scripts/setup-test-env.sh
│       ├── sample.pdf
│       ├── sample-signature.svg
│       ├── signer-with-chain.p12    (password: testpassword123)
│       ├── mock-hsm-key.pem
│       └── mock-hsm-cert.pem
├── docs/API.md                      full user-facing API reference
├── scripts/
│   ├── setup-test-env.sh            generates all test fixtures (OpenSSL + Node.js)
│   └── generate-fixtures.js
├── dist/                            compiled output (generated by npm run build)
├── package.json
├── tsconfig.json                    target ES2022, module CommonJS, strict: true
└── jest.config.ts
```

---

## 5. Module Reference

### 5.1 `src/PdfSigner.ts` — Public Façade

Owns the phase ordering contract. Creates one `VisualStamper` and one `CryptoStore` at construction time.

**Constructor options:**
```typescript
new PdfSigner({
  defaultPlaceholderSize?: number,  // bytes for /Contents hex slot, default 16384
  hsmTimeoutMs?: number,            // HSM callback timeout, default 30000
})
```

**Three public methods:**

| Method | What it does |
|--------|--------------|
| `signLocal(options)` | Phase 1 (optional) → Phase 2 with P12 |
| `signRemote(options)` | Phase 1 (optional) → Phase 2 with HSM callback |
| `verifyByteRangeIntegrity(buffer)` | Arithmetic consistency check only (not crypto verify) |

`signLocal` and `signRemote` share the same phase-1 stamping code path. The difference begins at `CryptoStore`.

---

### 5.2 `src/visual/VisualStamper.ts`

**`applyStamp(pdfBuffer, appearance, position)`**

Validates → resolves SVG → rasterises → embeds PNG → saves. Returns `VisualStampResult` with `stampedPdfBuffer`.

Key behaviors:
- Exactly one of `appearance.svgString` / `appearance.text` must be set — not both, not neither
- `svgString` must contain a `viewBox` attribute (Resvg requires it for reliable rendering)
- Default `renderScale: 2` renders the PNG at 2× the stamp point dimensions for crispness
- PDF saved with `{ useObjectStreams: false }` — mandatory (see §7.1)
- Page index is 0-based; validated against `pdfDoc.getPageCount()`

**`canvasYToPdfY(canvasY, stampHeightPts, pageHeightPts, pixelsPerPoint?)`** — static utility

PDF origin is bottom-left; canvas origin is top-left. Formula:
```
pdfY = pageHeightPts - (canvasY * pixelsPerPoint) - stampHeightPts
```

For 96dpi monitor: `pixelsPerPoint = 72 / 96 = 0.75`

---

### 5.3 `src/visual/svgToPdf.ts`

**`rasteriseSvgToPng(svgString, outputWidthPx, outputHeightPx)`**

1. Resvg renders SVG at native viewBox resolution
2. sharp resizes to exact `outputWidthPx × outputHeightPx` (`fit: 'fill'`, `kernel: lanczos3`)
3. sharp flattens alpha channel to white background (`flatten({ background: {r:255,g:255,b:255} })`)
4. Returns RGB PNG buffer (no alpha — color type byte in PNG IHDR = 2, not 6)

Alpha must be flattened. PDF viewers do not reliably render transparent PNGs embedded as XObjects.

**`generateTextSignatureSvg(text, fontSize, color)`**

Tries to load `src/visual/fonts/GreatVibes-Regular.woff2`, inlines it as base64 `@font-face` if found. Falls back to `Georgia, serif`. The viewBox width heuristic is `fontSize * text.length * 0.55 + 16`.

---

### 5.4 `src/engine/PdfEngine.ts`

The most mechanically intricate module. It manipulates raw PDF bytes rather than using pdf-lib's object model for the Sig dict, because pdf-lib cannot write fixed-width placeholder fields that must be overwritten in-place.

**Strategy: incremental update**
1. pdf-lib handles AcroForm setup and serialises the base PDF
2. PdfEngine appends a raw text incremental update (Sig dict + updated widget + xref + trailer)
3. `/ByteRange` and `/Contents` are fixed-width placeholders overwritten in-place

**`preparePdfForSigning(pdfInput, options)`** returns `PreparedPdf`:
```typescript
interface PreparedPdf {
  pdfBuffer: Buffer;       // complete PDF with real ByteRange + zero /Contents
  byteRange: ByteRange;    // {offset1, length1, offset2, length2}
  contentsOffset: number;  // byte index of first hex char in /Contents slot
  contentsLength: number;  // number of hex chars allocated
}
```

**ByteRange layout:**
```
[0 ──────────────── length1-1] [< hex_placeholder >] [offset2 ──── offset2+length2-1]
       segment1                   NOT SIGNED              segment2
       (includes stamp PNG)
```

Invariant that is asserted and must hold: `length1 + 1 + contentsLength + 1 + length2 === pdfBuffer.length`

**`extractSignableBytes(prepared)`** — concatenates the two segments, nothing else.

**`injectSignature(prepared, pkcs7HexString)`** — right-pads hex to `contentsLength` with `'0'`, writes in-place with `writeAsciiInPlace()`. Never resizes the buffer.

---

### 5.5 `src/crypto/pkcs7Builder.ts`

Builds PKCS#7/CMS DER structures byte-by-byte, citing RFC 5652 for every field. No high-level forge `.sign()` — every structure is explicitly assembled using `asn1Utils`.

**The Critical Tag Swap (RFC 5652 §5.4)**

`buildSignedAttributes()` returns two encodings of the same content:

```typescript
const signingForm   = derWrap(TAG_SET,      attrsContent);  // 0x31 — RSA signs this
const containerForm = derWrap(TAG_CONTEXT_0, attrsContent); // 0xA0 — stored in PKCS#7
```

**The private key signs `signingForm` (0x31). The PKCS#7 container stores `containerForm` (0xA0). Using 0xA0 for signing causes Adobe to reject the signature.**

**PKCS#7 container structure** (RFC 5652 §5):
```
ContentInfo SEQUENCE {
  contentType OID(SignedData)
  content [0] EXPLICIT SignedData SEQUENCE {
    version INTEGER 1
    digestAlgorithms SET { SHA-256 AlgId }
    encapContentInfo SEQUENCE { eContentType OID(id-data) }  ← no eContent (detached)
    certificates [0] IMPLICIT { signerCertDer + caCertsDer... }
    signerInfos SET { SignerInfo SEQUENCE {
      version INTEGER 1
      sid IssuerAndSerialNumber { issuerDer, serialNumber }
      digestAlgorithm SHA-256 AlgId
      signedAttrs [0] IMPLICIT (containerForm — 0xA0 tagged)
      signatureAlgorithm rsaEncryption + NULL
      signature OCTET STRING(signatureBytes)
    } }
  }
}
```

---

### 5.6 `src/utils/asn1Utils.ts`

DER encoding primitives. All values cite ITU-T X.690.

| Export | Purpose |
|--------|---------|
| `TAG_SEQUENCE = 0x30` | SEQUENCE (constructed) |
| `TAG_SET = 0x31` | SET (constructed) |
| `TAG_INTEGER = 0x02` | INTEGER |
| `TAG_OID = 0x06` | OBJECT IDENTIFIER |
| `TAG_OCTET_STRING = 0x04` | OCTET STRING |
| `TAG_UTC_TIME = 0x17` | UTCTime |
| `TAG_CONTEXT_0 = 0xa0` | [0] context-specific constructed |
| `encodeDerLength(n)` | short form (<128) or long form (≥128) |
| `derWrap(tag, contents)` | [tag][length][contents] |
| `encodeOid(oid)` | X.690 §8.19: base-128 encoding |
| `encodeInteger(buf)` | two's complement, sign bit preservation |
| `encodeIntegerValue(n)` | JS number → DER INTEGER |
| `encodeUtcTime(date)` | `YYMMDDHHMMSSZ` format |
| `encodeSha256AlgorithmIdentifier()` | SHA-256 AlgId shortcut |

---

### 5.7 `src/utils/certUtils.ts`

| Function | Purpose |
|----------|---------|
| `parseP12(buffer, password)` | Parse PKCS#12: extract signer cert + CA chain + private key; throws `InvalidCertificateError` on MAC mismatch |
| `parsePemCertificates(pem)` | Parse PEM bundle → `Buffer[]` of DER certs |
| `parsePemCertificate(pem)` | Single PEM → forge Certificate object |
| `parseDerCertificate(der)` | DER Buffer → forge Certificate object |
| `getIssuerDer(cert)` | Extract DER-encoded Issuer Name from TBS (used for IssuerAndSerialNumber in SignerInfo) |
| `getSerialNumberBuffer(cert)` | Hex serial → Buffer (handles odd-length hex) |

**P12 chain sorting**: RFC 7292 bags are unordered. `parseP12` identifies the leaf cert (not an issuer of any other cert in the bundle) and walks the chain by Subject→Issuer.

---

### 5.8 `src/utils/bufferUtils.ts`

| Function | Purpose |
|----------|---------|
| `writeAsciiInPlace(buf, str, offset)` | Write ASCII string into buffer at offset without resizing; throws if overflow |
| `findPattern(haystack, needle, from)` | Byte-pattern search; returns -1 if not found |
| `stringToPdfHex(str)` | UTF-8 string → hex string (for PDF hex string syntax) |
| `padNumber(n, width)` | Left-pad number with zeros |
| `hexToBuffer(hex)` / `bufferToHex(buf)` | Hex↔Buffer conversion |

---

### 5.9 `src/errors.ts`

All errors extend `PdfSignerError(message, code)`. Catch by class or by `.code` property.

| Class | Code | When thrown |
|-------|------|-------------|
| `SignatureOverflowError` | `SIGNATURE_OVERFLOW` | PKCS#7 DER > `/Contents` placeholder; `.actualBytes` and `.allocatedBytes` on the instance |
| `ByteRangeError` | `BYTE_RANGE_ERROR` | ByteRange invariant fails; PDF may be corrupt |
| `InvalidCertificateError` | `INVALID_CERTIFICATE` | Wrong P12 password, missing key, malformed cert |
| `InvalidPdfError` | `INVALID_PDF` | PDF cannot be loaded; corrupt, encrypted, or not a PDF |
| `InvalidAppearanceError` | `INVALID_APPEARANCE` | Neither/both of svgString/text; SVG missing viewBox; rasterisation failed |
| `InvalidPositionError` | `INVALID_POSITION` | Page index OOB; width or height ≤ 0 |
| `MissingPositionError` | `MISSING_POSITION` | `appearance` provided without `position` |
| `HsmTimeoutError` | `HSM_TIMEOUT` | HSM callback didn't resolve within `hsmTimeoutMs` |

---

## 6. Public API Surface

### `PdfSigner`

```typescript
class PdfSigner {
  constructor(options?: {
    defaultPlaceholderSize?: number;  // default 16384
    hsmTimeoutMs?: number;            // default 30000
  });

  async signLocal(options: LocalSignOptions): Promise<SignedPdfResult>;
  async signRemote(options: RemoteSignOptions): Promise<SignedPdfResult>;
  async verifyByteRangeIntegrity(signedPdfBuffer: Buffer): Promise<VerificationResult>;
}
```

### `LocalSignOptions`

```typescript
interface LocalSignOptions extends SigningMetadata {
  pdfBuffer: Buffer;
  p12Path?: string;        // path to .p12 file
  p12Buffer?: Buffer;      // or raw P12 bytes — one required
  p12Password: string;
  appearance?: SignatureAppearance;
  position?: StampPosition;  // required if appearance is set
}
```

### `RemoteSignOptions`

```typescript
interface RemoteSignOptions extends SigningMetadata {
  pdfBuffer: Buffer;
  signerCertPem?: string;   // PEM cert — one of these required
  signerCertDer?: Buffer;   // DER cert
  intermediateCerts?: (string | Buffer)[];  // CA chain
  hsmSignFunction: (signedAttrsBytes: Buffer) => Promise<Buffer>;
  appearance?: SignatureAppearance;
  position?: StampPosition;
}
```

**`hsmSignFunction` contract:** receives 0x31 SET-tagged SignedAttributes DER; must return raw signature bytes.

| Platform | Hashing | Pass to HSM |
|----------|---------|-------------|
| Node.js `crypto.createSign('SHA256')` | Internal | raw `signedAttrsBytes` |
| AWS KMS `MessageType:'DIGEST'` | **Caller must pre-hash** | `sha256(signedAttrsBytes)` |
| Azure Key Vault RS256 | Internal | raw `signedAttrsBytes` |
| GCP Cloud KMS SHA256_RSA_PKCS1 | Internal | raw `signedAttrsBytes` |

### `SigningMetadata`

```typescript
interface SigningMetadata {
  reason?: string;
  location?: string;
  contactInfo?: string;
  signerName?: string;
  signingDate?: Date;              // default: new Date()
  placeholderSizeBytes?: number;   // default: constructor's defaultPlaceholderSize
  subFilter?: 'adbe.pkcs7.detached' | 'ETSI.CAdES.detached';
}
```

### `SignatureAppearance`

```typescript
interface SignatureAppearance {
  svgString?: string;    // complete SVG with viewBox attribute
  text?: string;         // text to render in script font
  fontSize?: number;     // default 32
  color?: string;        // CSS color, default '#1a1a2e'
  renderScale?: number;  // PNG scale multiplier, default 2
}
```

### `StampPosition` (PDF points, bottom-left origin)

```typescript
interface StampPosition {
  page: number;    // 0-based
  x: number;       // points from left
  y: number;       // points from BOTTOM (PDF convention)
  width: number;   // > 0
  height: number;  // > 0
}
```

Page sizes in points: A4 = 595.28 × 841.89 | Letter = 612 × 792 | Legal = 612 × 1008

### `SignedPdfResult`

```typescript
interface SignedPdfResult {
  signedPdf: Buffer;
  documentHash: string;    // hex SHA-256 of ByteRange bytes
  pkcs7Hex: string;        // hex-encoded PKCS#7 DER
  byteRange: [number, number, number, number];  // [offset1, length1, offset2, length2]
  signingTime: string;     // UTC ISO 8601
}
```

To verify `documentHash` independently:
```typescript
const [o1, l1, o2, l2] = result.byteRange;
const seg1 = result.signedPdf.subarray(o1, o1 + l1);
const seg2 = result.signedPdf.subarray(o2, o2 + l2);
const expected = crypto.createHash('sha256').update(Buffer.concat([seg1, seg2])).digest('hex');
assert(result.documentHash === expected); // must be true
```

---

## 7. Critical Invariants (Never Break These)

These are the rules that, if violated, produce a PDF Adobe considers tampered with or that produces invalid DER.

### 7.1 `useObjectStreams: false` is mandatory everywhere

**Where**: Every `pdfDoc.save()` call — in `VisualStamper.applyStamp()` and `PdfEngine.preparePdfForSigning()`.

**Why**: ISO 32000-1 §7.5.7 defines object streams (PDF 1.5+ feature, tag `/ObjStm`). When enabled, object data is compressed into stream content — byte offsets become relative to the stream, not the file. PdfEngine needs every object to have an absolute, predictable byte offset so it can compute the ByteRange. With object streams enabled, the ByteRange calculation is indeterminate.

**Verification**: `strings output.pdf | grep ObjStm` must return nothing.

### 7.2 In-place buffer writes only after PDF is assembled

**Where**: `PdfEngine.injectSignature()` and the ByteRange write in `preparePdfForSigning()`.

**Why**: After `preparePdfForSigning()` fixes the ByteRange values, those values are absolute byte offsets into `pdfBuffer`. Any `Buffer.concat()` or string concatenation that produces a new buffer of different length makes the ByteRange wrong. The `/Contents` slot is a fixed-width hex string; writing it must not change the buffer length.

Always use `writeAsciiInPlace()` from `bufferUtils`. Never use `Buffer.concat()` or string operations after the ByteRange is written.

### 7.3 The ByteRange invariant must hold

```
length1 + 1 + contentsLength + 1 + length2 === pdfBuffer.length
```

Where:
- `length1` = bytes before the `<` that opens `/Contents`
- `contentsLength` = hex chars in the `/Contents` slot (= `placeholderSizeBytes * 2`)
- `length2` = bytes after the `>` that closes `/Contents`
- `+1` for the `<` character, `+1` for the `>` character

`preparePdfForSigning()` asserts this and throws `ByteRangeError` if it fails.

### 7.4 The RFC 5652 §5.4 tag swap is non-negotiable

`buildSignedAttributes()` returns two forms:

```typescript
signingForm   = derWrap(0x31, attrsContent);  // SET — RSA signs this
containerForm = derWrap(0xA0, attrsContent);  // [0] — stored in PKCS#7
```

The RSA private-key operation **must** sign the `signingForm` (0x31). The PKCS#7 stores `containerForm` (0xA0). Using 0xA0 for signing produces a structurally valid DER blob that Adobe always rejects with "invalid signature." This is the most common mistake when working with CMS signing.

### 7.5 Stamp must precede hash computation

The visual stamp is Phase 1. The SHA-256 hash is computed in Phase 2. The stamp's PNG bytes are in segment 1 of the ByteRange, meaning they are hashed. Never move hashing before stamping.

### 7.6 PDF date format is not ISO 8601

PDF dates use `D:YYYYMMDDHHmmssZ` (ISO 32000-1 §7.9.4). `Date.toISOString()` produces `2024-01-15T12:00:00.000Z` which is wrong for PDF. Use `formatPdfDate(date)` from `PdfEngine.ts`.

### 7.7 Signature widget annotation flag F=132

The widget annotation uses `F: 132` (binary `10000100`). Bit 3 (Print) + Bit 8 (Lock). Do not change this value. Adobe uses these flags to determine whether to display and lock the signature field.

### 7.8 xref entries must be exactly 20 bytes

Each cross-reference table entry is: `OOOOOOOOOO GGGGG F SP LF` — 10-digit offset + space + 5-digit generation + space + `n` + space + `\n`. `buildXrefSection()` handles this. Don't rewrite xref formatting.

---

## 8. Error Hierarchy

```
Error
  └─ PdfSignerError(message, code)
       ├─ SignatureOverflowError(actualBytes, allocatedBytes)   code: SIGNATURE_OVERFLOW
       ├─ ByteRangeError(detail)                                code: BYTE_RANGE_ERROR
       ├─ InvalidCertificateError(detail)                       code: INVALID_CERTIFICATE
       ├─ InvalidPdfError(detail)                               code: INVALID_PDF
       ├─ InvalidAppearanceError(detail)                        code: INVALID_APPEARANCE
       ├─ InvalidPositionError(detail)                          code: INVALID_POSITION
       ├─ MissingPositionError()                                code: MISSING_POSITION
       └─ HsmTimeoutError(timeoutMs)                            code: HSM_TIMEOUT
```

**Rules for adding new errors:**
1. Always extend `PdfSignerError` — never throw plain `Error` from library code
2. Define a unique uppercase `code` string
3. Export from `src/errors.ts`
4. Export from `src/index.ts`
5. Document in `docs/API.md` error reference table

**Rules for wrapping external errors:**
- P12 parse failures → `InvalidCertificateError`
- PDF load failures → `InvalidPdfError`
- SVG rasterisation failures → `InvalidAppearanceError`
- HSM callback non-`PdfSignerError` errors → `PdfSignerError` with code `'HSM_ERROR'`
- `PdfSignerError` subclasses pass through unwrapped

---

## 9. Testing Strategy

### Test suites

| File | What it tests |
|------|---------------|
| `test/local-signing.test.ts` | Full signing pipeline with P12: SVG stamp, text stamp, no stamp, error cases |
| `test/remote-hsm.test.ts` | Full pipeline with mock HSM: stamp, no stamp, timeout, network error |
| `test/pkcs7.test.ts` | PKCS#7 DER correctness: parseable, tag values, OIDs, messageDigest, tag swap |
| `test/visual-stamping.test.ts` | VisualStamper isolation: SVG, text, error cases, coordinate conversion, PNG alpha |

### Running tests

```bash
bash scripts/setup-test-env.sh   # generate fixtures (one-time, requires OpenSSL)
npm test                         # runs all jest suites
```

Test output PDFs are written to `test/output/` — open in Acrobat Reader to visually verify.

### Writing new tests

**For any new signing feature:**
1. Assert `result.documentHash` matches independently computed SHA-256 of ByteRange bytes
2. Assert `signer.verifyByteRangeIntegrity(result.signedPdf).valid === true`
3. Assert `result.signedPdf[0..1]` is valid PDF header (`%PDF`)
4. Write output to `test/output/` so it can be inspected in Adobe Acrobat

**For any new error condition:**
1. Write a test that triggers it and asserts the correct class with `.rejects.toThrow(TheErrorClass)`
2. Assert `.code` value: `.rejects.toMatchObject({ code: 'THE_CODE' })`

**For new DER structures:**
- Assert first byte is `0x30` for any top-level SEQUENCE
- Assert the structure is parseable: `forge.asn1.fromDer(...)` must not throw
- Assert specific byte patterns for OIDs if they are spec-defined

**Mock HSM pattern** (use this in tests):
```typescript
function mockHsmSignFunction(signedAttrsBytes: Buffer): Promise<Buffer> {
  const sign = crypto.createSign('SHA256'); // hashes internally — like Azure/GCP
  sign.update(signedAttrsBytes);
  return Promise.resolve(sign.sign(mockHsmKeyPem));
}
```

**For AWS KMS behavior** (pre-hash required):
```typescript
function mockAwsKmsHsm(signedAttrsBytes: Buffer): Promise<Buffer> {
  const digest = crypto.createHash('sha256').update(signedAttrsBytes).digest();
  const sign = crypto.createSign('RSA-SHA256');
  // Use sign with pre-hashed digest — but crypto.sign with 'RSA' accepts Buffer directly
  return Promise.resolve(crypto.sign(null, digest, privateKey));
}
```

---

## 10. Development Workflow

### Build

```bash
npm run build       # tsc → dist/
```

TypeScript config: ES2022 target, CommonJS modules, strict mode, declaration files, source maps. `dist/` is gitignored but published via `prepublishOnly`.

### Test

```bash
npm test
```

No lint step configured by default (`npm run lint` runs eslint if eslint is installed).

### Verifying a signed PDF outside Adobe

```bash
# Extract PKCS#7 from /Contents slot
CONTENTS=$(grep -oP '(?<=/Contents <)[0-9a-fA-F]+' signed.pdf | head -1)
echo "$CONTENTS" | xxd -r -p > signature.der

# Verify DER structure
openssl pkcs7 -inform DER -in signature.der -print_certs -noout
openssl asn1parse -inform DER -in signature.der | head -40
```

First byte of `signature.der` must be `0x30`. The `openssl pkcs7` command must succeed without errors.

---

## 11. Implementing New Features

This section tells you exactly where to add code for each category of feature.

### 11.1 Adding a new visual stamp type

**File**: `src/visual/VisualStamper.ts` and `src/visual/VisualStamper.types.ts`

Steps:
1. Add a new optional field to `SignatureAppearance` in `VisualStamper.types.ts`
2. Add a mutual-exclusion check in `applyStamp()` — exactly one stamp source must be set
3. Generate or accept an SVG string for the new stamp type
4. Route through `rasteriseSvgToPng()` — all stamp types must produce a PNG
5. Export the new type field from `src/index.ts`
6. Add a test in `test/visual-stamping.test.ts`

Do not bypass `rasteriseSvgToPng()`. The PNG embedding path through pdf-lib is the only correct way to inject visual content that the ByteRange will cover.

### 11.2 Adding a new signing algorithm (e.g. ECDSA)

**Files**: `src/crypto/pkcs7Builder.ts`, `src/utils/asn1Utils.ts`

The current implementation uses rsaEncryption (OID `1.2.840.113549.1.1.1`). To support ECDSA:

1. Add the ECDSA OID constants in `pkcs7Builder.ts` (RFC 5480: `1.2.840.10045.4.3.2` for ecdsa-with-SHA256)
2. In `buildSignerInfo()`, conditionally use the ECDSA AlgorithmIdentifier for `signatureAlgorithm`
3. For local signing: use Node.js `crypto.sign()` instead of forge's RSA `.sign()`
4. For remote HSM: no change needed — the HSM returns raw signature bytes regardless of algorithm
5. Add a new `signatureAlgorithm` option to `SigningMetadata` or detect from certificate key type
6. Note: ECDSA signatures are DER-encoded (sequence of two integers); RSA signatures are raw bytes

### 11.3 Adding multiple signers (counter-signatures)

**File**: `src/crypto/pkcs7Builder.ts` — `assemblePkcs7()`

Currently `signerInfos SET { SingleSignerInfo }`. For multiple signers:
1. Accept an array of `{ signatureBytes, signerCert, containerFormAttrs }` in `assemblePkcs7`
2. Build one `SignerInfo` per signer using `buildSignerInfo()`
3. Wrap all in `signerInfos = derWrap(TAG_SET, Buffer.concat(allSignerInfos))`
4. Put all signer certs in the `certificates [0]` field
5. Note: each SignerInfo uses an independent signing operation but the same `documentHash`

### 11.4 Adding timestamp authority (TSA) support

**Files**: `src/crypto/pkcs7Builder.ts`, `src/crypto/CryptoStore.ts`

A RFC 3161 timestamp is added as an unsigned attribute in the SignerInfo, after the signature is produced:
1. After getting `signatureBytes`, call the TSA endpoint with `SHA-256(signatureBytes)`
2. The TSA returns a TimeStampToken (also a PKCS#7)
3. Add unsigned attribute OID `1.2.840.113549.1.9.6` (id-countersignature) or `1.2.840.113549.1.9.16.2.14` (id-aa-timeStampToken) wrapping the TST
4. Add `unsignedAttrs [1] IMPLICIT` field to `buildSignerInfo()` using `TAG_CONTEXT_1`
5. This requires changing `assemblePkcs7`'s SignerInfo structure

### 11.5 Adding a new metadata field to the Sig dict

**File**: `src/engine/PdfEngine.ts` — `buildRawSigDict()`

Sig dict fields are written as PDF hex strings via `stringToPdfHex()`. To add a new field:
1. Add the field to `SignaturePlaceholderOptions` in `PdfEngine.types.ts`
2. Add a conditional line in `buildRawSigDict()`: `if (options.newField) dict += '/NewField <${stringToPdfHex(options.newField)}>\n';`
3. Add the field to `SigningMetadata` in `CryptoStore.types.ts`
4. Thread it through `CryptoStore.signWithLocalCertificate()` and `signWithRemoteHsm()`
5. Thread it through `PdfSigner.signLocal()` and `signRemote()`
6. Export from `src/index.ts` if it appears in a public interface
7. Document in `docs/API.md`

**Warning**: Adding a new field increases the Sig dict length. This shifts the byte offset of `/Contents`, changing the ByteRange calculation. This is fine — `preparePdfForSigning()` recalculates dynamically. But it means existing signed PDFs have different ByteRange values from PDFs signed after the change, which is expected and correct.

### 11.6 Adding signature validation (beyond ByteRange arithmetic)

**File**: New `src/crypto/SignatureVerifier.ts` (add it here)

`verifyByteRangeIntegrity()` checks arithmetic only. Full crypto verification requires:
1. Extract `/Contents` hex → PKCS#7 DER buffer
2. Parse with `forge.asn1.fromDer()` or `pkijs`
3. Extract `signedAttrs` from SignerInfo (rebuild with 0x31 tag for hash verification)
4. Verify `messageDigest` attribute matches SHA-256 of ByteRange bytes
5. Verify RSA signature: `forge.pki.rsa.PublicKey.verify(hash, signature)`
6. Optionally validate certificate chain against a trust store
7. Return structured result with cert info, validity period, revocation status

Add the method to `PdfSigner` and export result types from `src/index.ts`.

### 11.7 Adding support for encrypted PDFs

**File**: `src/engine/PdfEngine.ts` — `preparePdfForSigning()`

Currently `ignoreEncryption: false`. For encrypted PDF support:
1. Accept a `pdfPassword?: string` option in `SignaturePlaceholderOptions`
2. If provided, pass `{ password: options.pdfPassword }` to `PDFDocument.load()`
3. Throw `InvalidPdfError` if the PDF is encrypted and no password is given (current behavior is correct)

### 11.8 Adding a new output format

Currently only `Buffer` is returned. To support streaming:
- The signing pipeline requires the complete PDF in memory (ByteRange calculation needs the total buffer length upfront)
- Do not attempt streaming unless you redesign the ByteRange pre-calculation approach
- The `signedPdf` field in `SignedPdfResult` could be changed to `Uint8Array` for browser compatibility, but `Buffer` extends `Uint8Array` in Node.js so no callers break

---

## 12. Standards & Specification Map

Every non-obvious implementation detail in this codebase is grounded in a published specification. When making changes to cryptographic or PDF structures, consult these.

| Topic | File | Specification |
|-------|------|---------------|
| PDF ByteRange mechanism | `PdfEngine.ts` | ISO 32000-1 §12.8.1, Table 252 |
| PDF object streams ban | `VisualStamper.ts`, `PdfEngine.ts` | ISO 32000-1 §7.5.7 |
| PDF AcroForm | `PdfEngine.ts` | ISO 32000-1 §12.7.2 |
| PDF widget annotation flags | `PdfEngine.ts` | ISO 32000-1 Table 164 |
| PDF date format | `PdfEngine.ts` `formatPdfDate()` | ISO 32000-1 §7.9.4 |
| PDF xref entry format | `PdfEngine.ts` `buildXrefSection()` | ISO 32000-1 §7.5.4 |
| CMS SignedData structure | `pkcs7Builder.ts` | RFC 5652 §5 |
| CMS signed attributes tag swap | `pkcs7Builder.ts` | RFC 5652 §5.3, §5.4 |
| CMS detached signature (no eContent) | `pkcs7Builder.ts` | RFC 5652 §5.2 |
| CMS IssuerAndSerialNumber | `pkcs7Builder.ts` `buildSignerInfo()` | RFC 5652 §10.2.4 |
| PKCS#12 bag parsing | `certUtils.ts` | RFC 7292 |
| RSA signature algorithm | `pkcs7Builder.ts` | RFC 3279 §2.3.1 |
| DER tag/length encoding | `asn1Utils.ts` | ITU-T X.690 §8 |
| DER OID encoding | `asn1Utils.ts` `encodeOid()` | ITU-T X.690 §8.19 |
| DER INTEGER encoding | `asn1Utils.ts` `encodeInteger()` | ITU-T X.690 §8.3 |
| DER UTCTime format | `asn1Utils.ts` `encodeUtcTime()` | ITU-T X.690 §11.8 |
| SHA-256 OID | everywhere | 2.16.840.1.101.3.4.2.1 (NIST FIPS 180-4 / RFC 5754) |
| rsaEncryption OID | `pkcs7Builder.ts` | 1.2.840.113549.1.1.1 (RFC 3279) |
| SignedData OID | `pkcs7Builder.ts` | 1.2.840.113549.1.7.2 (RFC 5652) |
| id-data OID | `pkcs7Builder.ts` | 1.2.840.113549.1.7.1 (RFC 5652) |

---

## 13. Common Pitfalls

These are mistakes that are easy to make and hard to diagnose because they produce a syntactically valid PDF that Adobe silently rejects.

### P1: Using 0xA0 to sign instead of 0x31

**Symptom**: Adobe shows "Invalid signature" with no other detail.
**Cause**: The RSA private-key operation was applied to `containerForm` (0xA0) instead of `signingForm` (0x31).
**Fix**: Always pass `signingForm` to the signing operation. `buildPkcs7Local()` and `buildSignedAttributes()` handle this correctly — don't bypass them.

### P2: Enabling object streams

**Symptom**: `ByteRangeError` or a PDF that opens but shows signature as invalid because the ByteRange values are wrong.
**Cause**: `pdfDoc.save({ useObjectStreams: true })` (the default in pdf-lib) was used.
**Fix**: Always pass `{ useObjectStreams: false }` to every `pdfDoc.save()` call.

### P3: Resizing the buffer after ByteRange is written

**Symptom**: ByteRange invariant assertion fails; `ByteRangeError` thrown.
**Cause**: A `Buffer.concat()` or string concatenation was performed after `preparePdfForSigning()` returned.
**Fix**: Only use `writeAsciiInPlace()` for post-preparation writes.

### P4: Wrong PDF date format

**Symptom**: Some PDF readers show "Invalid date" or ignore the date field. Adobe shows no signing time.
**Cause**: Using `Date.toISOString()` instead of `formatPdfDate()`.
**Fix**: Use `formatPdfDate(date)` from `PdfEngine.ts`. PDF dates are `D:YYYYMMDDHHmmssZ`.

### P5: Applying stamp after sign

**Symptom**: Adobe shows "This document has been modified after the signature was applied."
**Cause**: `VisualStamper.applyStamp()` called on an already-signed PDF.
**Fix**: Always stamp first, sign second. `PdfSigner` enforces this order internally.

### P6: SVG without viewBox

**Symptom**: `InvalidAppearanceError: svgString must include a viewBox attribute`.
**Cause**: SVG provided without a `viewBox` attribute.
**Fix**: Add `viewBox="0 0 W H"` to the `<svg>` element. Resvg requires it for reliable rendering.

### P7: Forgetting to export new types/errors from `src/index.ts`

**Symptom**: TypeScript consumers can't import the new type; it's only accessible via deep imports.
**Fix**: Add all new public types, interfaces, and error classes to `src/index.ts` exports.

### P8: P12 password MAC mismatch

**Symptom**: `InvalidCertificateError: PKCS#12 MAC verification failed`.
**Cause**: Wrong password passed to `signLocal()`, or the P12 file is corrupted.
**Debug**: `openssl pkcs12 -info -in cert.p12 -passin pass:PASSWORD -nokeys` — must succeed.

### P9: Placeholder too small for certificate chain

**Symptom**: `SignatureOverflowError: PKCS#7 (N bytes) exceeds placeholder (16384 bytes)`.
**Fix**: The error message provides the exact size needed. Pass `placeholderSizeBytes: N + 512` to the signing call. Typical sizes: single cert ≈ 3–4KB, full 3-cert chain ≈ 10–14KB.

### P10: Coordinates in wrong system

**Symptom**: Stamp appears at wrong position or outside page bounds.
**Cause**: Browser Y coordinates (top-left origin) passed directly without conversion.
**Fix**: Use `VisualStamper.canvasYToPdfY(canvasY, stampHeight, pageHeight, 72/screenDPI)` to convert. PDF origin is bottom-left; Y increases upward.

---

## Quick Reference Card

```
Add stamp type     → VisualStamper.types.ts + VisualStamper.ts
New sig algorithm  → pkcs7Builder.ts + asn1Utils.ts
New metadata field → PdfEngine.types.ts → buildRawSigDict() → CryptoStore.types.ts
                     → CryptoStore.ts → PdfSigner.ts → index.ts → docs/API.md
New error          → errors.ts → index.ts → docs/API.md
New test           → test/[suite].test.ts, assert ByteRange + documentHash independently
Build              → npm run build  (tsc → dist/)
Test               → npm test       (fixtures in test/fixtures/, output in test/output/)
Verify signed PDF  → openssl pkcs7 -inform DER -in sig.der -print_certs -noout
```

---

*pdf-signer v1.0.0 — This CLAUDE.md is authoritative for agent operation. Keep it in sync when adding features, new error types, or changing invariants.*
