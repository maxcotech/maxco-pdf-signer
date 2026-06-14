#!/usr/bin/env bash
# setup-test-env.sh — Generate all test fixtures using OpenSSL + Node.js
# Usage: bash scripts/setup-test-env.sh
# Requires: openssl >= 1.1.1, node >= 18, npm

set -euo pipefail

FIXTURES="test/fixtures"
OUTPUT="test/output"
mkdir -p "$FIXTURES" "$OUTPUT"

echo "==> Generating CA key and certificate..."
openssl genrsa -out "$FIXTURES/ca.key" 2048 2>/dev/null
openssl req -new -x509 -days 365 \
  -key "$FIXTURES/ca.key" \
  -out "$FIXTURES/ca.crt" \
  -subj "/CN=Test Root CA/O=TestOrg/C=US" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

echo "==> Generating intermediate CA..."
openssl genrsa -out "$FIXTURES/intermediate.key" 2048 2>/dev/null
openssl req -new \
  -key "$FIXTURES/intermediate.key" \
  -out "$FIXTURES/intermediate.csr" \
  -subj "/CN=Test Intermediate CA/O=TestOrg/C=US"

cat > /tmp/intermediate-ext.cnf << 'EXTEOF'
[v3_ca]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always,issuer
EXTEOF

openssl x509 -req -days 365 \
  -in "$FIXTURES/intermediate.csr" \
  -CA "$FIXTURES/ca.crt" \
  -CAkey "$FIXTURES/ca.key" \
  -CAcreateserial \
  -out "$FIXTURES/intermediate.crt" \
  -extfile /tmp/intermediate-ext.cnf \
  -extensions v3_ca 2>/dev/null

echo "==> Generating signer certificate..."
openssl genrsa -out "$FIXTURES/signer.key" 2048 2>/dev/null
openssl req -new \
  -key "$FIXTURES/signer.key" \
  -out "$FIXTURES/signer.csr" \
  -subj "/CN=Test Signer/O=TestOrg/C=US/emailAddress=signer@test.local"

cat > /tmp/signer-ext.cnf << 'EXTEOF'
[v3_signer]
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,nonRepudiation
extendedKeyUsage=emailProtection
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always,issuer
subjectAltName=email:signer@test.local
EXTEOF

openssl x509 -req -days 365 \
  -in "$FIXTURES/signer.csr" \
  -CA "$FIXTURES/intermediate.crt" \
  -CAkey "$FIXTURES/intermediate.key" \
  -CAcreateserial \
  -out "$FIXTURES/signer.crt" \
  -extfile /tmp/signer-ext.cnf \
  -extensions v3_signer 2>/dev/null

echo "==> Creating PKCS#12 bundle with chain (password: testpassword123)..."
openssl pkcs12 -export \
  -inkey "$FIXTURES/signer.key" \
  -in "$FIXTURES/signer.crt" \
  -certfile "$FIXTURES/intermediate.crt" \
  -name "Test Signer" \
  -caname "Test Intermediate CA" \
  -out "$FIXTURES/signer-with-chain.p12" \
  -passout pass:testpassword123 2>/dev/null

echo "==> Creating signer-only PKCS#12 (no chain)..."
openssl pkcs12 -export \
  -inkey "$FIXTURES/signer.key" \
  -in "$FIXTURES/signer.crt" \
  -out "$FIXTURES/signer-cert-only.p12" \
  -passout pass:testpassword123 2>/dev/null

echo "==> Generating mock HSM key and certificate..."
openssl genrsa -out "$FIXTURES/mock-hsm-key.pem" 2048 2>/dev/null
openssl req -new -x509 -days 365 \
  -key "$FIXTURES/mock-hsm-key.pem" \
  -out "$FIXTURES/mock-hsm-cert.pem" \
  -subj "/CN=Mock HSM Signer/O=TestOrg/C=US" \
  -addext "basicConstraints=CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature"

echo "==> Generating sample.pdf (2-page PDF with text)..."
node -e "
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
async function main() {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Page 1
  const page1 = pdfDoc.addPage([612, 792]);
  page1.drawText('Test PDF — Page 1', {
    x: 50, y: 720, size: 24, font, color: rgb(0, 0, 0)
  });
  page1.drawText('This document is used for testing the pdf-signer library.', {
    x: 50, y: 680, size: 12, font, color: rgb(0.3, 0.3, 0.3)
  });
  page1.drawText('Signature field will be placed below:', {
    x: 50, y: 620, size: 12, font, color: rgb(0, 0, 0)
  });
  page1.drawRectangle({
    x: 50, y: 540, width: 250, height: 60,
    borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 1
  });

  // Page 2
  const page2 = pdfDoc.addPage([612, 792]);
  page2.drawText('Test PDF — Page 2', {
    x: 50, y: 720, size: 24, font, color: rgb(0, 0, 0)
  });
  page2.drawText('Continuation page for multi-page signature tests.', {
    x: 50, y: 680, size: 12, font, color: rgb(0.3, 0.3, 0.3)
  });

  const pdfBytes = await pdfDoc.save();
  require('fs').writeFileSync('test/fixtures/sample.pdf', Buffer.from(pdfBytes));
  console.log('sample.pdf created (' + pdfBytes.length + ' bytes)');
}
main().catch(e => { console.error(e); process.exit(1); });
"

echo "==> Writing sample-signature.svg..."
cat > "$FIXTURES/sample-signature.svg" << 'SVGEOF'
<svg viewBox="0 0 300 80" xmlns="http://www.w3.org/2000/svg">
  <path d="M10,60 C30,20 50,20 70,50 C90,80 110,10 130,40 C150,70 170,30 190,45 C210,60 220,40 240,35 C260,30 270,50 285,45"
    stroke="#1a1a2e" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M10,65 L285,65" stroke="#1a1a2e" fill="none" stroke-width="0.5" opacity="0.4"/>
</svg>
SVGEOF

echo ""
echo "==> All fixtures generated successfully:"
ls -la "$FIXTURES/"
echo ""
echo "==> Run tests with: npm test"
