# Integrating the pdf-signer service

This is the guide for building a **document-upload-and-sign feature in another app** against a running pdf-signer API. It is self-contained: you do not need to read the library source, and you should not need `CLAUDE.md` (that file is the operating manual for changing pdf-signer itself, not for calling it).

If you are an AI coding agent, the [Rules snippet](#12-rules-snippet) at the bottom is designed to be copied verbatim into your project's `AGENTS.md`, `CLAUDE.md` or `.cursor/rules`.

---

## 1. What the service does

You upload a PDF. It comes back with

- an optional **visible signature stamp** — a signature image (SVG) or a name rendered in a script font, drawn onto a page you choose, and
- a **cryptographic seal** (PKCS#7/CMS detached signature) that covers the whole document *including the stamp pixels*.

Adobe Acrobat Reader shows the result as "signature valid, document not modified." Because the stamp is inside the signed byte range, nobody can move or replace the stamp afterwards without invalidating the signature.

The signing certificate lives on the server. Your app never handles a private key.

---

## 2. The 30-second version

```bash
npm install pdf-signer
```

```typescript
import { PdfSignerClient } from 'pdf-signer/client';

const client = new PdfSignerClient({
  baseUrl: process.env.PDF_SIGNER_URL!,   // e.g. https://signer.internal
  apiKey: process.env.PDF_SIGNER_API_KEY!,
});

// 1. Learn the page geometry — you cannot place a stamp without it
const { pages, encrypted } = await client.inspect(pdfBuffer);
if (encrypted) throw new Error('Password-protected PDFs cannot be signed');

// 2. Sign. Send the rectangle in whatever space you measured it in.
const { signedPdf, stampRect } = await client.sign({
  pdf: pdfBuffer,
  appearance: { text: 'Jane Smith' },
  position: {
    page: 0,
    x: 120, y: 80, width: 200, height: 60,
    origin: 'top-left',      // browser coordinates
    units: 'px',             // measured in rendered pixels
    viewportWidth: 1000,     // ...over a page rendered 1000px wide
  },
  metadata: { reason: 'Approved', location: 'Lagos, Nigeria' },
});
```

**Use the client.** It is dependency-free, typed, and it encodes the multipart body correctly — which is the part that is easy to get wrong by hand (see [§6](#6-the-wire-format-trap)). If you cannot use it (different language, edge runtime), read §6 before writing the request yourself.

---

## 3. The flow: inspect → place → sign

Always in that order.

```
┌──────────────────────────────────────────────────────────────┐
│ 1. User uploads a PDF                                        │
│                                                              │
│ 2. POST /api/v1/documents/inspect                            │
│      → pageCount, per-page widthPts/heightPts/rotation,      │
│        encrypted, signatureCount                             │
│                                                              │
│    Reject here if: encrypted === true                        │
│    Warn here if:   signatureCount > 0  (already signed)      │
│                                                              │
│ 3. Your UI: user picks a page and drags a signature box      │
│      → you have a rectangle in browser pixels                │
│                                                              │
│ 4. POST /api/v1/sign                                         │
│      pdf + appearance + position (+ metadata)                │
│      → signed PDF bytes, plus X-Stamp-Rect telling you       │
│        exactly where the stamp landed                        │
└──────────────────────────────────────────────────────────────┘
```

Step 2 is not optional busywork. A stamp rectangle is meaningless without the page dimensions it is relative to — an A4 page is 595×842 points, a Letter page 612×792 — and `inspect` is how you get them without shipping your own PDF parser. It is read-only: nothing is stored, modified or signed.

---

## 4. Authentication

Every `/api/v1` route requires a shared secret in the `x-api-key` header.

```
x-api-key: <the API_KEY the service was configured with>
```

`GET /health` needs no key. A missing or wrong key returns `401` with `code: "UNAUTHORIZED"`.

This is a single shared secret, not per-user auth. **Keep it server-side.** Do not ship it to a browser or mobile client: anyone holding it can sign arbitrary documents with your organisation's certificate. Your app's backend should call the signing service; your frontend should call your backend.

---

## 4a. Calling from a browser (CORS)

The service answers cross-origin requests only from an allowlist, configured with
`CORS_ORIGINS` (comma-separated, no trailing slashes). It ships defaulting to:

```
CORS_ORIGINS=http://localhost:3100,https://signsig-business-dev.netlify.app
```

An origin outside the list gets a normal `200` with **no**
`Access-Control-Allow-Origin` header — the browser is what blocks it, not the
server. Callers that send no `Origin` at all (curl, server-to-server, tests) are
unaffected by the list.

Two things the allowlist handles that are easy to miss if you proxy this yourself:

- **`x-api-key` is not a CORS-safelisted request header**, so every authenticated
  call triggers a preflight. The service answers `OPTIONS` with `204` *before*
  authentication, because a preflight carries no API key and would otherwise
  `401`.
- **The `X-*` result headers are exposed explicitly.** A cross-origin `fetch`
  can only read headers named in `Access-Control-Expose-Headers`, so
  `X-Document-Hash`, `X-Byte-Range`, `X-Signing-Time`, `X-Stamp-Rect` and
  `Content-Disposition` are listed. Without that the sign call still succeeds and
  `documentHash` comes back empty — a silent failure, not an error.

Note this does not change the advice above: an allowlisted origin still has to
send `x-api-key`, so a browser calling the service directly means shipping the
shared secret to the client. Use it for a trusted internal tool or local
development; for a public frontend, keep calling through your own backend.

---

## 5. Coordinates — read this section

This is where integrations go wrong, and it fails *silently*: the signature is cryptographically perfect and simply appears in the wrong place.

**Two conventions are in play.**

| | Origin | Y direction | Unit |
|---|---|---|---|
| PDF (the service default) | bottom-left | up | points (1/72 inch) |
| Browser / canvas / CSS | top-left | down | pixels of a rendered page |

**Do not convert by hand.** Declare the space your numbers are in and the server converts them against the real page geometry:

```typescript
position: {
  page: 0,
  x: 120,               // as measured
  y: 80,                // as measured
  width: 200,
  height: 60,
  origin: 'top-left',   // 'bottom-left' (default) | 'top-left'
  units: 'px',          // 'pt' (default) | 'px'
  viewportWidth: 1000,  // pixel width of the page you measured over
}
```

### Where `viewportWidth` comes from

It is the **rendered page width in pixels**, not your container, not the window.

```typescript
// pdf.js
const viewport = page.getViewport({ scale });
// viewport.width is exactly what to send

// A rendered <canvas> or <img> of the page
const rect = pageCanvas.getBoundingClientRect();
// rect.width — the page element itself, not its scroll container
```

`viewportHeight` works interchangeably. If you send both, they are cross-checked against the page aspect ratio and a mismatch greater than 2% is rejected — that mismatch means you measured the wrong element, which is worth catching.

### If you prefer to send points

Fine — omit `origin` and `units`, and do the arithmetic yourself against the `widthPts`/`heightPts` from `inspect`:

```typescript
const page = inspection.pages[0];

// 200x60pt stamp, 40pt in from the bottom-right corner
const position = {
  page: 0,
  x: page.widthPts - 200 - 40,
  y: 40,                          // 40pt UP from the bottom
  width: 200,
  height: 60,
};
```

### Verify placement without opening the PDF

A successful signing response carries `X-Stamp-Rect`: the rectangle actually drawn, in points, bottom-left origin. The client exposes it as `result.stampRect`. Assert against it in tests, or log it — it is how you confirm a conversion did what you meant.

### Rotated pages

A page with a non-zero `rotation` (from `inspect`) displays a different box than the coordinate space it is drawn in. `origin: 'top-left'` and `units: 'px'` are **rejected** for such pages rather than being converted to a plausible-but-wrong position. Send user-space points for those; `rotation` is unaffected by them. `displayWidthPts`/`displayHeightPts` from `inspect` tell you the box a viewer shows.

---

## 6. The wire format trap

`POST /api/v1/sign` is `multipart/form-data`, and `metadata`, `appearance` and `position` are **form fields containing JSON strings** — not nested object parts.

```javascript
// ✅ CORRECT
form.append('position', JSON.stringify({ page: 0, x: 50, y: 40, width: 200, height: 60 }));

// ❌ WRONG — serialises to the literal string "[object Object]"
form.append('position', { page: 0, x: 50, y: 40, width: 200, height: 60 });
```

The wrong version fails with `VALIDATION_ERROR` / "Must be a valid JSON string", which does not obviously point at the mistake. `PdfSignerClient` does this correctly; that is most of why it exists.

Raw request, for reference:

```bash
curl -X POST "$PDF_SIGNER_URL/api/v1/sign" \
  -H "x-api-key: $PDF_SIGNER_API_KEY" \
  -F "pdf=@contract.pdf" \
  -F 'metadata={"reason":"Approved","location":"Lagos, Nigeria"}' \
  -F 'appearance={"text":"Jane Smith","fontSize":36}' \
  -F 'position={"page":0,"x":350,"y":40,"width":200,"height":60}' \
  -o signed.pdf
```

---

## 7. Endpoint reference

The authoritative contract is the OpenAPI 3.1 document — served at `/openapi.json` by a running instance, committed at [docs/openapi.json](docs/openapi.json), and browsable at `/docs`. Point a client generator at it if you are not using TypeScript.

### `POST /api/v1/documents/inspect`

`multipart/form-data` with one `pdf` file part. Returns:

```json
{
  "sizeBytes": 24576,
  "pageCount": 2,
  "pages": [
    {
      "index": 0,
      "widthPts": 612,
      "heightPts": 792,
      "rotation": 0,
      "displayWidthPts": 612,
      "displayHeightPts": 792
    }
  ],
  "encrypted": false,
  "signatureCount": 0,
  "signable": true
}
```

- `widthPts`/`heightPts` — **use these for stamp arithmetic**
- `rotation` — 0, 90, 180 or 270; non-zero blocks browser-coordinate conversion
- `encrypted` — `true` means this document cannot be signed at all; reject the upload
- `signatureCount` — signatures already present anywhere in the file, including earlier revisions

An encrypted PDF returns `200` with `encrypted: true`, not an error — you need the fact in order to explain the rejection to a user.

### `POST /api/v1/sign`

`multipart/form-data`:

| Part | Required | Type |
|---|---|---|
| `pdf` | yes | file |
| `appearance` | no | JSON string |
| `position` | no | JSON string — **required whenever `appearance` is present** |
| `metadata` | no | JSON string |

Omit both `appearance` and `position` for an invisible, cryptographic-only signature. That is a valid and common case.

**`appearance`** — exactly one of `svgString` or `text`:

```typescript
{ svgString?: string   // complete SVG; MUST contain a viewBox attribute
  text?: string        // rendered in a bundled script font
  fontSize?: number    // text mode, default 32
  color?: string       // text mode, default '#1a1a2e'
  renderScale?: number // rasterisation quality, default 2
}
```

**`metadata`** — all optional:

```typescript
{ reason?: string                // → signature dictionary /Reason
  location?: string
  contactInfo?: string
  signerName?: string
  signingDate?: string           // ISO 8601; defaults to the server clock
  placeholderSizeBytes?: number  // see SIGNATURE_OVERFLOW below
  subFilter?: 'adbe.pkcs7.detached' | 'ETSI.CAdES.detached'
}
```

Use `subFilter: 'ETSI.CAdES.detached'` for eIDAS/PAdES contexts; otherwise leave it alone.

**Response** — `200` with `Content-Type: application/pdf` and the signed bytes as the body, plus:

| Header | Meaning |
|---|---|
| `X-Document-Hash` | Hex SHA-256 of the signed byte range |
| `X-Byte-Range` | `[offset1, length1, offset2, length2]` — the spans the signature covers |
| `X-Signing-Time` | UTC ISO 8601 timestamp embedded in the signature |
| `X-Stamp-Rect` | Present only when a stamp was drawn: `{page,x,y,width,height}` in points, bottom-left origin |

---

## 8. Errors and what to do about each one

Every non-2xx response is `{ error, code }`. **Branch on `code`** — it is stable. Never parse `error`; it is human-readable prose and will change.

`VALIDATION_ERROR` responses also carry `details: [{ field, message }]` naming each rejected field, so you can map failures onto form inputs.

| `code` | HTTP | What happened | What to do |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or wrong `x-api-key` | Fix configuration. Not retryable. |
| `MISSING_FILE` | 400 | No `pdf` part in the body | Bug in your request construction. |
| `VALIDATION_ERROR` | 400 | A field failed schema validation | Read `details`. Usually a JSON-encoding mistake (§6) or a bad `position`. |
| `MISSING_POSITION` | 400 | `appearance` sent without `position` | Send both, or neither. |
| `INVALID_POSITION` | 400 | Page index out of range, or the rectangle lies entirely off the page | Almost always an unconverted browser coordinate. Re-read §5. |
| `INVALID_APPEARANCE` | 400 | Both or neither of `svgString`/`text`; SVG missing `viewBox`; SVG failed to render | Send exactly one source. Add `viewBox="0 0 W H"` to the SVG root. |
| `INVALID_PDF` | 400 | Not a PDF, corrupt, or encrypted | Reject the upload. Catch this at `inspect` time instead. |
| `SIGNATURE_OVERFLOW` | 400 | The signature did not fit the allocated slot | **Retryable.** See below. |
| `PAYLOAD_TOO_LARGE` | 413 | Upload exceeds the server's limit (default 25MB) | Reject with a size message before uploading. |
| `INVALID_CERTIFICATE` | 500 | The server's own certificate failed to load | Server misconfiguration. Alert an operator; retrying will not help. |
| `BYTE_RANGE_ERROR` | 500 | Internal structural failure | Report it. Not caused by your request. |
| `INTERNAL_ERROR` | 500 | Unexpected failure | Retry once, then report. |

### `SIGNATURE_OVERFLOW` — the one error worth handling automatically

The signature is written into a fixed-size slot reserved before signing. A long certificate chain can exceed the default 16KB. The error tells you exactly how much space was needed:

```json
{
  "error": "PKCS#7 (17004 bytes) exceeds placeholder (16384 bytes). Set placeholderSizeBytes >= 17516.",
  "code": "SIGNATURE_OVERFLOW",
  "actualBytes": 17004,
  "allocatedBytes": 16384
}
```

Retry once with a larger slot:

```typescript
import { PdfSignerApiError } from 'pdf-signer/client';

async function signWithRetry(request) {
  try {
    return await client.sign(request);
  } catch (err) {
    const retrySize =
      err instanceof PdfSignerApiError ? err.suggestedPlaceholderSize : undefined;
    if (!retrySize) throw err;

    return await client.sign({
      ...request,
      metadata: { ...request.metadata, placeholderSizeBytes: retrySize },
    });
  }
}
```

`suggestedPlaceholderSize` is `actualBytes + 512` and is `undefined` for every other error, so the guard above doubles as the error check. If your certificate chain always overflows, set `placeholderSizeBytes` permanently rather than paying for a failed request each time — roughly 4KB for a single certificate, 10–14KB for a three-certificate chain.

---

## 9. Validating an upload before you sign it

Do this at upload time, not at signing time — a user who has already positioned a signature should not then be told the file was never usable.

```typescript
const inspection = await client.inspect(pdfBuffer);

if (inspection.encrypted) {
  throw new BadRequest('This PDF is password-protected. Please upload an unprotected copy.');
}
if (!inspection.signable) {
  throw new BadRequest('This PDF could not be read.');
}
if (inspection.signatureCount > 0) {
  // Not fatal — counter-signing is legitimate. But if your flow assumes a
  // fresh document, warn the user rather than silently adding a second signature.
}
```

Also enforce your own size limit before uploading: the service rejects above `MAX_UPLOAD_MB` (default 25) with `413`, and a rejected 25MB upload wastes the user's bandwidth twice.

A non-PDF upload is caught by `inspect` with `INVALID_PDF`. Do not rely on the file extension or the browser-reported MIME type; both are attacker-controlled.

---

## 10. A complete worked example

An Express endpoint in a consuming app: accepts an upload plus a browser-space rectangle, and returns the signed document.

```typescript
import express from 'express';
import multer from 'multer';
import { PdfSignerClient, PdfSignerApiError } from 'pdf-signer/client';

const client = new PdfSignerClient({
  baseUrl: process.env.PDF_SIGNER_URL!,
  apiKey: process.env.PDF_SIGNER_API_KEY!,
});

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });
const app = express();

// Called by your own frontend. The signing API key never leaves this process.
app.post('/documents/:id/sign', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // The rectangle the user dragged, in the space the browser measured it in.
  const box = JSON.parse(req.body.box) as {
    page: number; x: number; y: number; width: number; height: number;
    viewportWidth: number;
  };

  try {
    const inspection = await client.inspect(req.file.buffer);

    if (inspection.encrypted) {
      return res.status(400).json({ error: 'Password-protected PDFs cannot be signed' });
    }
    if (box.page >= inspection.pageCount) {
      return res.status(400).json({ error: `Document has only ${inspection.pageCount} pages` });
    }

    const request = {
      pdf: req.file.buffer,
      appearance: { text: req.body.signerName },
      position: {
        page: box.page,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        origin: 'top-left' as const,
        units: 'px' as const,
        viewportWidth: box.viewportWidth,
      },
      metadata: {
        reason: req.body.reason,
        signerName: req.body.signerName,
        contactInfo: req.body.email,
      },
    };

    let result;
    try {
      result = await client.sign(request);
    } catch (err) {
      // The one error worth retrying automatically.
      const retrySize =
        err instanceof PdfSignerApiError ? err.suggestedPlaceholderSize : undefined;
      if (!retrySize) throw err;
      result = await client.sign({
        ...request,
        metadata: { ...request.metadata, placeholderSizeBytes: retrySize },
      });
    }

    // Persist the hash alongside the document: it is the audit record proving
    // what was signed, and it is independently verifiable from the PDF itself.
    await saveSignatureRecord(req.params.id, {
      documentHash: result.documentHash,
      signingTime: result.signingTime,
      stampRect: result.stampRect,
    });

    res.set('Content-Type', 'application/pdf');
    res.send(Buffer.from(result.signedPdf));
  } catch (err) {
    if (err instanceof PdfSignerApiError) {
      // 4xx codes are the caller's fault and safe to surface; 5xx are ours.
      const status = err.status >= 500 ? 502 : 400;
      return res.status(status).json({ error: err.message, code: err.code, details: err.details });
    }
    throw err;
  }
});
```

---

## 11. Things that will bite you

- **The stamp is in the wrong place.** You sent browser Y as if it were PDF Y. Declare `origin: 'top-left'` and `units: 'px'` with `viewportWidth`, and check `X-Stamp-Rect` against what you drew. (§5)
- **`VALIDATION_ERROR: Must be a valid JSON string`.** You appended an object to `FormData` instead of `JSON.stringify(...)`. (§6)
- **The signature is valid but Adobe says the document was modified.** Something altered the PDF *after* signing. Do not re-save, re-compress, linearise, or "optimise" the returned bytes — store and serve them byte-for-byte. Any modification breaks the seal, by design.
- **`INVALID_APPEARANCE: svgString must include a viewBox`.** Add `viewBox="0 0 W H"` to your `<svg>` root element. A width/height attribute is not a substitute.
- **A stamp on the wrong page.** `page` is **0-based**. Page 1 as a user sees it is `page: 0`.
- **`SIGNATURE_OVERFLOW` on every request.** Your certificate chain is bigger than the default slot. Set `placeholderSizeBytes` permanently. (§8)
- **An off-page rectangle is rejected, not silently drawn.** If you meant to bleed a stamp past a margin, that is allowed — only a rectangle with *no* overlap at all is refused.
- **Signing is not instant.** Rasterising a stamp and building the signature takes a few seconds. Do it in a background job or with a proper loading state; the client's default timeout is 60s.

---

## 12. Rules snippet

Copy this into your project's agent rules file (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`) so the constraints stay in context while the feature is built.

```markdown
## Signing PDFs via the pdf-signer service

Use `PdfSignerClient` from `pdf-signer/client`. Never hand-build the multipart
request: `metadata`, `appearance` and `position` are form fields containing JSON
*strings*, and appending an object to FormData silently sends "[object Object]".

The flow is always: inspect → place → sign.
1. `client.inspect(pdf)` for pageCount and per-page widthPts/heightPts/rotation.
   Reject the upload if `encrypted`. Warn if `signatureCount > 0`.
2. Build the position.
3. `client.sign({ pdf, appearance, position, metadata })`.

Coordinates: the service defaults to PDF points with a BOTTOM-LEFT origin.
Browser coordinates are top-left pixels. Do not convert by hand — send
`origin: 'top-left'`, `units: 'px'`, `viewportWidth: <rendered page width in px>`
and let the server convert. Verify with `result.stampRect`. Pages with a non-zero
`rotation` reject conversion; send points for those.

`position` is required whenever `appearance` is present. Omit both for an
invisible cryptographic-only signature. `page` is 0-based.

Errors: branch on `err.code`, never on the message. `VALIDATION_ERROR` carries
`details: [{field, message}]`. `SIGNATURE_OVERFLOW` is the only retryable one —
retry with `metadata.placeholderSizeBytes = err.suggestedPlaceholderSize`.

Never expose the API key to a client device — it can sign arbitrary documents.
Route signing through your own backend.

Store the returned PDF bytes verbatim. Re-saving, compressing or optimising it
invalidates the signature.
```

---

## Further reading

- `/docs` on a running instance — Swagger UI, with a working "Try it out" once you paste your API key
- [docs/openapi.json](docs/openapi.json) — the machine-readable contract; feed it to a client generator
- [docs/API.md](docs/API.md) — reference for using the library in-process instead of over HTTP (including the remote-HSM signing path, which the REST API does not expose)
