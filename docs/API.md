# pdf-signer API Reference

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [How It Works](#how-it-works)
4. [Class: PdfSigner](#class-pdfsigner)
5. [Interfaces](#interfaces)
6. [Coordinate System Reference](#coordinate-system-reference)
7. [Error Reference](#error-reference)
8. [SVG Signature Guidelines](#svg-signature-guidelines)
9. [Certificate Chain Requirements](#certificate-chain-requirements)
10. [Placeholder Size Guidelines](#placeholder-size-guidelines)
11. [Verifying Your Signed PDF](#verifying-your-signed-pdf)
12. [HSM Integration Patterns](#hsm-integration-patterns)

---

## Installation

```bash
npm install pdf-signer
```

---

## Quick Start

### SVG signature + local P12

```typescript
import { PdfSigner } from 'pdf-signer';
import fs from 'fs';

const signer = new PdfSigner();

const result = await signer.signLocal({
  pdfBuffer: fs.readFileSync('contract.pdf'),
  p12Path: './certificate.p12',
  p12Password: 'your-password',
  appearance: {
    svgString: fs.readFileSync('signature.svg', 'utf8'),
  },
  position: { page: 0, x: 50, y: 40, width: 200, height: 60 },
  reason: 'Approved',
  location: 'New York, USA',
  contactInfo: 'signer@example.com',
});

fs.writeFileSync('signed.pdf', result.signedPdf);
console.log('Document hash:', result.documentHash);
console.log('Signing time:', result.signingTime);
```

### Text signature + remote HSM

```typescript
import { PdfSigner } from 'pdf-signer';
import fs from 'fs';

const signer = new PdfSigner({ hsmTimeoutMs: 60000 });

const result = await signer.signRemote({
  pdfBuffer: fs.readFileSync('contract.pdf'),
  signerCertPem: fs.readFileSync('signer.pem', 'utf8'),
  hsmSignFunction: async (signedAttrsBytes) => {
    // Pass to your HSM — see HSM Integration Patterns below
    return await myHsm.sign(signedAttrsBytes);
  },
  appearance: { text: 'Jane Smith', fontSize: 36, color: '#1a3a6e' },
  position: { page: 2, x: 100, y: 80, width: 220, height: 70 },
  reason: 'Authorized',
});

fs.writeFileSync('signed.pdf', result.signedPdf);
```

---

## How It Works

### Execution Order

```
PDF Input
    │
    ▼
[1] VisualStamper.applyStamp()
    • SVG/text → PNG (resvg + sharp)
    • Embed PNG XObject into PDF page
    • Serialize with useObjectStreams:false
    │
    ▼
Stamped PDF Buffer (stamp pixels now committed to bytes)
    │
    ▼
[2] PdfEngine.preparePdfForSigning()
    • Add AcroForm + signature widget
    • Append Sig dict with ByteRange/Contents placeholders
    • Calculate ByteRange arithmetic
    • Write ByteRange in-place
    │
    ▼
[3] Extract ByteRange bytes → SHA-256 → documentHash
    (stamp pixels are INSIDE this hash)
    │
    ▼
[4] Build PKCS#7/CMS SignedData DER
    • Build SignedAttributes (contentType, signingTime, messageDigest)
    • RSA sign the 0x31-tagged SignedAttributes (local) or call HSM (remote)
    • Assemble ContentInfo → SignedData → SignerInfo
    │
    ▼
[5] PdfEngine.injectSignature()
    • Write PKCS#7 hex into /Contents slot (in-place, same byte count)
    │
    ▼
Signed PDF (Adobe-recognized digital signature)
```

### Why Order Matters

**The stamp MUST be applied before the cryptographic signature.**

The PKCS#7 signature covers the PDF byte range defined by `/ByteRange`. This range includes
every byte in the document *except* the `/Contents` hex value itself. If the stamp were applied
*after* signing, its pixels would be outside the ByteRange, and Adobe would display:
**"The document has been modified after the signature was applied."**

### The ByteRange Mechanism

```
┌──────────────────────────────────────────────────────────────────┐
│ PDF bytes                                                         │
│                                                                   │
│ [Segment 1: offset1=0, length1=N]  [Sig dict...              ]   │
│ 0───────────────────────────────N  │/ByteRange [0 N M L]    │   │
│                                    │/Contents <             │   │
│                                    │  ← hex placeholder →   │   │
│                                    │>                       │   │
│                                    │...                     │   │
│                                 N+1│                        │M  │
│                              [Segment 2: offset2=M, length2=L]   │
│                              M─────────────────────────────────  │
└──────────────────────────────────────────────────────────────────┘

Signed content = Segment1 + Segment2
NOT signed     = '<' + hex(PKCS#7) + '>'
```

### PKCS#7 CMS Container Structure

```
ContentInfo SEQUENCE {                          -- RFC 5652 §3
  contentType OID 1.2.840.113549.1.7.2
  content [0] EXPLICIT SignedData SEQUENCE {   -- RFC 5652 §5.1
    version INTEGER 1
    digestAlgorithms SET { SHA-256 AlgId }
    encapContentInfo SEQUENCE {
      eContentType OID 1.2.840.113549.1.7.1
      -- eContent ABSENT (detached signature)
    }
    certificates [0] IMPLICIT {               -- all chain certs
      signerCert DER
      intermediateCert DER
      rootCert DER
    }
    signerInfos SET { SignerInfo SEQUENCE {   -- RFC 5652 §5.3
      version INTEGER 1
      sid IssuerAndSerialNumber
      digestAlgorithm SHA-256 AlgId
      signedAttrs [0] IMPLICIT {             -- 0xA0 tag in container
        contentType Attribute
        signingTime Attribute
        messageDigest Attribute              -- SHA-256(ByteRange bytes)
      }
      signatureAlgorithm rsaEncryption AlgId
      signature OCTET STRING               -- RSA signature
    } }
  }
}
```

---

## Class: PdfSigner

### Constructor

```typescript
new PdfSigner(options?: PdfSignerConstructorOptions)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `defaultPlaceholderSize` | `number` | `16384` | Default PKCS#7 placeholder size in bytes |
| `hsmTimeoutMs` | `number` | `30000` | HSM callback timeout in milliseconds |

### `signLocal(options)` → `Promise<SignedPdfResult>`

Apply visual stamp then sign with a local PKCS#12 certificate.

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `pdfBuffer` | `Buffer` | ✓ | Input PDF bytes |
| `p12Password` | `string` | ✓ | PKCS#12 decryption password |
| `p12Path` | `string` | ✓* | Path to .p12/.pfx file |
| `p12Buffer` | `Buffer` | ✓* | Raw PKCS#12 bytes |
| `appearance` | `SignatureAppearance` | — | Visual stamp (SVG or text) |
| `position` | `StampPosition` | ✓ if appearance | Stamp coordinates in PDF points |
| `reason` | `string` | — | Signature reason metadata |
| `location` | `string` | — | Signing location metadata |
| `contactInfo` | `string` | — | Contact info metadata |
| `signerName` | `string` | — | Signer name in Sig dict |
| `signingDate` | `Date` | — | Override signing timestamp |
| `placeholderSizeBytes` | `number` | `16384` | PKCS#7 placeholder size |
| `subFilter` | `string` | `adbe.pkcs7.detached` | CMS sub-filter |

*Either `p12Path` or `p12Buffer` must be provided.

**Throws:**
- `MissingPositionError` — appearance provided without position
- `InvalidAppearanceError` — SVG malformed or both svgString/text provided
- `InvalidCertificateError` — wrong P12 password or missing private key
- `ByteRangeError` — PDF structure cannot be prepared
- `SignatureOverflowError` — PKCS#7 exceeds placeholder (increase `placeholderSizeBytes`)

### `signRemote(options)` → `Promise<SignedPdfResult>`

Apply visual stamp then sign with an external Cloud HSM/KMS.

**Additional parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `signerCertPem` | `string` | ✓* | PEM-encoded signer certificate |
| `signerCertDer` | `Buffer` | ✓* | DER-encoded signer certificate |
| `intermediateCerts` | `(string \| Buffer)[]` | — | CA chain certificates |
| `hsmSignFunction` | `Function` | ✓ | Async signing callback (see below) |

*Either `signerCertPem` or `signerCertDer` must be provided.

**`hsmSignFunction` contract:**
```typescript
(signedAttrsBytes: Buffer) => Promise<Buffer>
```
- Input: 0x31 SET-tagged DER-encoded SignedAttributes
- Output: raw RSA-PKCS1v15 or ECDSA signature bytes
- Hashing responsibility varies by platform — see HSM Integration Patterns

**Throws:**
- `HsmTimeoutError` — HSM callback did not resolve within `hsmTimeoutMs`
- All errors from `signLocal` (except certificate-related)

### `verifyByteRangeIntegrity(buffer)` → `Promise<VerificationResult>`

Check that a signed PDF's ByteRange arithmetic is internally consistent.

**What it checks:**
- `/ByteRange` is present and parseable
- `length1 + 1 + contentsSlotSize + 1 + length2 === fileSize`
- `offset2 > length1`
- `length2 > 0`

**What it does NOT check:**
- The cryptographic validity of the PKCS#7 signature
- Whether the signing certificate is trusted or not revoked
- Whether the certificate has expired

For cryptographic verification, use Adobe Acrobat Reader or the OpenSSL commands in the
[Verifying Your Signed PDF](#verifying-your-signed-pdf) section.

---

## Interfaces

### `SignatureAppearance`

```typescript
interface SignatureAppearance {
  svgString?: string;    // Complete SVG document with viewBox
  text?: string;         // Text rendered in script font
  fontSize?: number;     // Default: 32
  color?: string;        // CSS color. Default: '#1a1a2e'
  renderScale?: number;  // PNG scale factor. Default: 2
}
```

Provide exactly one of `svgString` or `text`.

### `StampPosition`

```typescript
interface StampPosition {
  page: number;    // 0-based page index
  x: number;       // PDF points from left edge
  y: number;       // PDF points from BOTTOM edge (PDF convention)
  width: number;   // Stamp width in points
  height: number;  // Stamp height in points
}
```

**All values in PDF user-space points (1 point = 1/72 inch).**
See [Coordinate System Reference](#coordinate-system-reference) for browser conversion.

### `SigningMetadata`

```typescript
interface SigningMetadata {
  reason?: string;
  location?: string;
  contactInfo?: string;
  signerName?: string;
  signingDate?: Date;
  placeholderSizeBytes?: number;
  subFilter?: 'adbe.pkcs7.detached' | 'ETSI.CAdES.detached';
}
```

### `SignedPdfResult`

```typescript
interface SignedPdfResult {
  signedPdf: Buffer;          // Complete signed PDF bytes
  documentHash: string;       // Hex SHA-256 of ByteRange bytes
  pkcs7Hex: string;           // Hex-encoded PKCS#7 DER
  byteRange: [number, number, number, number]; // [offset1, length1, offset2, length2]
  signingTime: string;        // UTC ISO 8601 timestamp
}
```

### `VerificationResult`

```typescript
interface VerificationResult {
  valid: boolean;
  details: {
    fileSize: number;
    byteRange: [number, number, number, number];
    segment1Covers: string;    // e.g. "bytes 0–45231"
    segment2Covers: string;    // e.g. "bytes 78000–91442"
    contentsSlotSize: number;  // hex chars allocated
    errors: string[];
  };
}
```

---

## Coordinate System Reference

```
PDF coordinate system: origin BOTTOM-LEFT, Y increases UPWARD
Browser/canvas:        origin TOP-LEFT,    Y increases DOWNWARD

Conversion (browser canvas at screenDPI to PDF points):
  pdfX = canvasX * (72 / screenDPI)
  pdfY = pageHeightPts - (canvasY * (72 / screenDPI)) - stampHeightPts

For 96dpi (standard monitor):
  pdfX = canvasX * 0.75
  pdfY = pageHeightPts - (canvasY * 0.75) - stampHeightPts

Common page sizes in points (width × height):
  A4:     595.28 × 841.89
  Letter: 612.00 × 792.00
  Legal:  612.00 × 1008.00
  A3:     841.89 × 1190.55
```

### `VisualStamper.canvasYToPdfY(canvasY, stampHeightPts, pageHeightPts, pixelsPerPoint?)`

```typescript
// Example: signature at Y=200px on 96dpi canvas, A4 page, 60pt tall stamp
const pdfY = VisualStamper.canvasYToPdfY(200, 60, 841.89, 72 / 96);
// pdfY ≈ 841.89 - 150 - 60 = 631.89
```

### Capturing from HTML canvas (client-side)

```javascript
const canvas = document.getElementById('sig-canvas');
const rect = canvas.getBoundingClientRect();
const dpr = window.devicePixelRatio || 1;
const screenDpi = 96 * dpr;
const pixelsPerPoint = 72 / screenDpi;

// Stamp dimensions in PDF points
const stampWidthPts = 200;
const stampHeightPts = 60;

// Capture where user drew signature
const sigBounds = getSignatureBoundingBox(canvas); // your implementation

const position = {
  page: 0,
  x: sigBounds.x * pixelsPerPoint,
  y: VisualStamper.canvasYToPdfY(sigBounds.y, stampHeightPts, pageHeightPts, pixelsPerPoint),
  width: stampWidthPts,
  height: stampHeightPts,
};
```

---

## Error Reference

| Class | Code | Cause | Resolution |
|---|---|---|---|
| `SignatureOverflowError` | `SIGNATURE_OVERFLOW` | PKCS#7 larger than `/Contents` placeholder | Increase `placeholderSizeBytes` to at least `actualBytes + 512` |
| `ByteRangeError` | `BYTE_RANGE_ERROR` | ByteRange invariant violated | File may be corrupt; try re-saving source PDF |
| `InvalidCertificateError` | `INVALID_CERTIFICATE` | Wrong P12 password, missing key, or malformed cert | Check password; verify P12 with `openssl pkcs12 -info` |
| `InvalidPdfError` | `INVALID_PDF` | PDF cannot be loaded (corrupt, encrypted, or not a PDF) | Check source file; decrypt if password-protected |
| `InvalidAppearanceError` | `INVALID_APPEARANCE` | Neither/both of svgString/text provided, or SVG lacks viewBox | Provide exactly one; ensure SVG has `viewBox` attribute |
| `InvalidPositionError` | `INVALID_POSITION` | Page index out of range, width ≤ 0, or height ≤ 0 | Check page count and dimensions |
| `MissingPositionError` | `MISSING_POSITION` | `appearance` provided without `position` | Always provide `position` when using `appearance` |
| `HsmTimeoutError` | `HSM_TIMEOUT` | HSM callback did not resolve within timeout | Increase `hsmTimeoutMs`; check HSM connectivity |

---

## SVG Signature Guidelines

### Supported SVG features
- Path elements (`<path d="...">`)
- Basic shapes (`<rect>`, `<circle>`, `<line>`, `<polyline>`)
- Transforms (`translate`, `rotate`, `scale`)
- Stroke and fill properties
- ViewBox scaling
- Embedded fonts (as data URIs)

### Unsupported features
- External resource references (`<image href="http://...">`)
- JavaScript (`<script>`)
- CSS animations (`@keyframes`)
- Filters requiring GPU (complex SVG filters may render differently)

### Recommended viewBox for handwritten paths

```xml
<svg viewBox="0 0 300 80" xmlns="http://www.w3.org/2000/svg">
  <path d="M10,60 C30,20 70,10 120,50 ..." 
    stroke="#1a1a2e" fill="none" 
    stroke-width="2.5" stroke-linecap="round"/>
</svg>
```

Keep viewBox aspect ratio consistent with the `StampPosition` width/height ratio for best results.

### Capturing from HTML canvas

```javascript
// In the browser, after user draws signature on canvas:
const canvas = document.getElementById('sig-canvas');
const svg = canvasToSvgPath(canvas); // Convert strokes to SVG path

// Server-side signing:
const result = await signer.signLocal({
  pdfBuffer,
  p12Path: './cert.p12',
  p12Password: process.env.P12_PASS,
  appearance: { svgString: svg },
  position: { page: 0, x: 50, y: 40, width: 200, height: 60 },
});
```

---

## Certificate Chain Requirements

For maximum Adobe compatibility, the PKCS#12 bundle should contain:
1. The signer (leaf) certificate with `digitalSignature` key usage
2. All intermediate CA certificates
3. Optionally the root CA certificate

```bash
# Verify your P12 bundle
openssl pkcs12 -info -in certificate.p12 -nokeys -passin pass:yourpassword
```

For remote HSM signing, provide the certificate chain via `intermediateCerts`:
```typescript
const result = await signer.signRemote({
  signerCertPem: signerCert,
  intermediateCerts: [intermediateCert, rootCert], // DER Buffers or PEM strings
  hsmSignFunction: myHsm.sign,
  // ...
});
```

---

## Placeholder Size Guidelines

The default `placeholderSizeBytes: 16384` (16KB) is sufficient for most certificate chains.
If you receive `SignatureOverflowError`, the error message tells you the exact size needed:

```
PKCS#7 (18432 bytes) exceeds placeholder (16384 bytes).
Set placeholderSizeBytes >= 18944.
```

Typical sizes:
- Single self-signed cert: ~3–4 KB
- Cert + 1 intermediate: ~6–8 KB
- Full chain (3 certs): ~10–14 KB
- Default 16 KB covers most real-world chains

---

## Verifying Your Signed PDF

### Adobe Acrobat Reader
Open the signed PDF in Adobe Acrobat Reader. The signature panel shows validity,
signer identity, and whether the document was modified after signing.

### OpenSSL CLI commands

```bash
# 1. Extract the /Contents hex from the signed PDF
CONTENTS_HEX=$(grep -oP '(?<=/Contents <)[0-9a-fA-F]+' signed.pdf | head -1)

# 2. Convert hex to DER and inspect with OpenSSL
echo "$CONTENTS_HEX" | xxd -r -p > signature.der
openssl pkcs7 -inform DER -in signature.der -print_certs -noout

# 3. Verify the DER structure
openssl asn1parse -inform DER -in signature.der

# 4. Extract embedded certificates
openssl pkcs7 -inform DER -in signature.der -print_certs -out certs.pem
openssl x509 -in certs.pem -noout -subject -issuer -dates
```

### Programmatic ByteRange verification

```typescript
import { PdfSigner } from 'pdf-signer';
import fs from 'fs';

const signer = new PdfSigner();
const result = await signer.verifyByteRangeIntegrity(fs.readFileSync('signed.pdf'));

console.log('ByteRange valid:', result.valid);
console.log('Covers:', result.details.segment1Covers, '+', result.details.segment2Covers);
console.log('Errors:', result.details.errors);
```

---

## HSM Integration Patterns

### AWS KMS

```typescript
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import * as crypto from 'crypto';

const kmsClient = new KMSClient({ region: 'us-east-1' });

const hsmSignFunction = async (signedAttrsBytes: Buffer): Promise<Buffer> => {
  // AWS KMS MessageType:'DIGEST' requires a pre-hashed SHA-256 digest.
  // The caller must hash because KMS does NOT hash the input for DIGEST type.
  const digest = crypto.createHash('sha256').update(signedAttrsBytes).digest();

  const response = await kmsClient.send(new SignCommand({
    KeyId: 'arn:aws:kms:us-east-1:123456789012:key/your-key-id',
    Message: digest,
    MessageType: 'DIGEST',
    SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
  }));

  return Buffer.from(response.Signature!);
};

const result = await signer.signRemote({ hsmSignFunction, signerCertPem, /* ... */ });
```

### Azure Key Vault

```typescript
import { CryptographyClient } from '@azure/keyvault-keys';
import { DefaultAzureCredential } from '@azure/identity';

const client = new CryptographyClient(keyId, new DefaultAzureCredential());

const hsmSignFunction = async (signedAttrsBytes: Buffer): Promise<Buffer> => {
  // Azure RS256 hashes internally — pass raw signedAttrs bytes, do NOT pre-hash.
  const result = await client.sign('RS256', signedAttrsBytes);
  return Buffer.from(result.result);
};
```

### GCP Cloud KMS

```typescript
import { KeyManagementServiceClient } from '@google-cloud/kms';

const kmsClient = new KeyManagementServiceClient();

const hsmSignFunction = async (signedAttrsBytes: Buffer): Promise<Buffer> => {
  // GCP SHA256_RSA_PKCS1 hashes internally — pass raw bytes.
  const [response] = await kmsClient.asymmetricSign({
    name: 'projects/PROJECT/locations/REGION/keyRings/RING/cryptoKeys/KEY/cryptoKeyVersions/1',
    data: signedAttrsBytes,
  });
  return Buffer.from(response.signature as Uint8Array);
};
```

### Mock HSM (Testing)

```typescript
import * as crypto from 'crypto';
import * as fs from 'fs';

const mockHsmSignFunction = async (signedAttrsBytes: Buffer): Promise<Buffer> => {
  // crypto.createSign('SHA256') hashes internally — equivalent to Azure/GCP behavior
  const pem = fs.readFileSync('test/fixtures/mock-hsm-key.pem', 'utf8');
  const sign = crypto.createSign('SHA256');
  sign.update(signedAttrsBytes);
  return sign.sign(pem);
};
```

---

## Specification References

| Topic | Specification |
|---|---|
| PDF Digital Signatures | ISO 32000-1 §12.8 |
| PDF ByteRange | ISO 32000-1 §12.8.1, Table 252 |
| PDF Date Format | ISO 32000-1 §7.9.4 |
| PDF Object Streams | ISO 32000-1 §7.5.7 |
| PKCS#7 / CMS SignedData | RFC 5652 §5 |
| Signed Attributes (tag swap) | RFC 5652 §5.3, §5.4 |
| PKCS#12 Format | RFC 7292 |
| X.509 Certificates | RFC 5280 |
| DER Encoding Rules | ITU-T X.690 |
| OID: SHA-256 | 2.16.840.1.101.3.4.2.1 |
| OID: rsaEncryption | 1.2.840.113549.1.1.1 |
| OID: SignedData | 1.2.840.113549.1.7.2 |

---

*pdf-signer v1.0.0*
