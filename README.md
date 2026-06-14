# pdf-signer

Enterprise-grade PDF digital signature library for Node.js/TypeScript.

Applies a **visible signature stamp** (SVG or styled text) and a **PKCS#7/CMS cryptographic seal** in a single atomic call. The stamp is covered by the cryptographic hash — any post-signing modification is detectable by Adobe Acrobat Reader.

Two signing paths:
- **Path A — Local P12**: signs using a `.p12`/`.pfx` PKCS#12 file, all crypto in-process
- **Path B — Remote HSM**: decouples hash computation from signing; works with AWS KMS, Azure Key Vault, and GCP Cloud KMS

## Features

| Feature | Detail |
|---|---|
| Visual stamp | SVG (path/image) or text rendered in a script font |
| Cryptographic seal | PKCS#7/CMS detached signature, SHA-256 |
| Local signing | PKCS#12 (.p12/.pfx) support |
| Remote HSM | AWS KMS, Azure Key Vault, GCP Cloud KMS |
| ByteRange | Computed and written in-place (no buffer resize) |
| DER encoding | Built from scratch — every field cited to RFC/spec |
| Adobe recognized | adbe.pkcs7.detached + ETSI.CAdES.detached |
| SVG rendering | Rust-backed resvg (no headless browser required) |
| PNG compositing | sharp — white background, no alpha channel |

## Installation

```bash
npm install pdf-signer
```

## Quick Start

### SVG stamp + local P12

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
});

fs.writeFileSync('signed.pdf', result.signedPdf);
```

### Text stamp + remote HSM

```typescript
const result = await signer.signRemote({
  pdfBuffer: fs.readFileSync('contract.pdf'),
  signerCertPem: fs.readFileSync('cert.pem', 'utf8'),
  hsmSignFunction: async (signedAttrsBytes) => {
    return await myHsm.sign(signedAttrsBytes);
  },
  appearance: { text: 'Jane Smith', fontSize: 36, color: '#1a3a6e' },
  position: { page: 0, x: 100, y: 80, width: 220, height: 70 },
});
```

### Cryptographic-only (no stamp)

```typescript
const result = await signer.signLocal({
  pdfBuffer: fs.readFileSync('contract.pdf'),
  p12Buffer: fs.readFileSync('cert.p12'),
  p12Password: 'password',
  // No appearance/position — only the invisible cryptographic sig
});
```

## Test Setup

```bash
# Generate all test fixtures (requires OpenSSL + Node.js)
bash scripts/setup-test-env.sh

# Run tests
npm test

# Build
npm run build
```

## How It Works

```
Input PDF
  │
  ├─[1]─ VisualStamper.applyStamp()
  │         SVG/text → resvg → PNG → embed in PDF page
  │         Serialise with useObjectStreams:false
  │
  ├─[2]─ PdfEngine.preparePdfForSigning()
  │         Add AcroForm + signature widget
  │         Append Sig dict (ByteRange placeholder + Contents placeholder)
  │         Calculate and write real ByteRange in-place
  │
  ├─[3]─ SHA-256(ByteRange bytes) = documentHash
  │         Stamp pixels ARE inside ByteRange
  │
  ├─[4]─ Build PKCS#7/CMS DER from scratch
  │         SignedAttributes: contentType + signingTime + messageDigest
  │         Sign 0x31-tagged form (local RSA or HSM callback)
  │         Assemble ContentInfo → SignedData → SignerInfo
  │
  └─[5]─ Inject PKCS#7 hex into /Contents slot (in-place)
           → Adobe-recognized signed PDF
```

## Verifying Signed PDFs

```bash
# Open in Adobe Acrobat Reader for visual confirmation

# Verify with OpenSSL:
CONTENTS=$(grep -oP '(?<=/Contents <)[0-9a-fA-F]+' signed.pdf | head -1)
echo "$CONTENTS" | xxd -r -p > sig.der
openssl pkcs7 -inform DER -in sig.der -print_certs -noout
openssl asn1parse -inform DER -in sig.der
```

## Coordinate System

PDF uses bottom-left origin (Y increases upward). Browser canvas uses top-left origin.

```typescript
// Convert browser Y coordinate to PDF Y coordinate at 96dpi
const pdfY = VisualStamper.canvasYToPdfY(
  canvasY,        // pixels from top of canvas
  stampHeight,    // stamp height in PDF points
  pageHeight,     // page height in PDF points
  72 / 96,        // pixelsPerPoint at 96dpi
);

// Common page heights (points):
// A4:     841.89    Letter: 792.00
// Legal: 1008.00    A3:    1190.55
```

## Security Considerations

- Private keys in PKCS#12 are protected by the password. Use a strong password and restrict file permissions.
- For remote HSM path, the private key never leaves the HSM — only the SignedAttributes bytes are transmitted.
- The `hsmSignFunction` receives 0x31 SET-tagged DER. For AWS KMS `MessageType:'DIGEST'`, pre-hash these bytes with SHA-256 before sending.
- Certificate chain is embedded in the PKCS#7. Ensure intermediate certs are included for chain verification.
- The library does not verify certificate validity or revocation — use a trust store for that.

## API Documentation

See [docs/API.md](docs/API.md) for complete API reference including all interfaces, error types, HSM integration patterns, and coordinate system conversion details.

## License

MIT
