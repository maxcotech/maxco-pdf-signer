#!/usr/bin/env node
/**
 * Generate all test fixtures using node-forge (no OpenSSL required).
 * Run: node scripts/generate-fixtures.js
 */

'use strict';
const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');
const OUTPUT = path.join(__dirname, '..', 'test', 'output');

fs.mkdirSync(FIXTURES, { recursive: true });
fs.mkdirSync(OUTPUT, { recursive: true });

function generateKeyPair(bits = 2048) {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits, workers: -1 }, (err, keypair) => {
      if (err) reject(err);
      else resolve(keypair);
    });
  });
}

function buildCert({ subject, issuer, issuerKey, subjectKey, isCA, serial, extensions = [] }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = subjectKey.publicKey;
  cert.serialNumber = serial.toString(16).padStart(2, '0');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const subjectAttrs = Object.entries(subject).map(([shortName, value]) => ({ shortName, value }));
  cert.setSubject(subjectAttrs);

  const issuerAttrs = Object.entries(issuer).map(([shortName, value]) => ({ shortName, value }));
  cert.setIssuer(issuerAttrs);

  const exts = [
    { name: 'basicConstraints', cA: isCA, critical: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: true },
    ...extensions,
  ];

  if (isCA) {
    exts.push({ name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true });
  } else {
    exts.push({ name: 'keyUsage', digitalSignature: true, nonRepudiation: true, critical: true });
    exts.push({ name: 'extKeyUsage', emailProtection: true });
  }

  cert.setExtensions(exts);
  cert.sign(issuerKey.privateKey, forge.md.sha256.create());
  return cert;
}

async function main() {
  console.log('Generating RSA key pairs (this takes a moment)...');

  const [caKeys, intKeys, signerKeys, hsmKeys] = await Promise.all([
    generateKeyPair(),
    generateKeyPair(),
    generateKeyPair(),
    generateKeyPair(),
  ]);

  console.log('Building certificates...');

  // Root CA
  const caCert = buildCert({
    subject: { CN: 'Test Root CA', O: 'TestOrg', C: 'US' },
    issuer: { CN: 'Test Root CA', O: 'TestOrg', C: 'US' },
    issuerKey: caKeys,
    subjectKey: caKeys,
    isCA: true,
    serial: 1,
  });

  // Intermediate CA
  const intCert = buildCert({
    subject: { CN: 'Test Intermediate CA', O: 'TestOrg', C: 'US' },
    issuer: { CN: 'Test Root CA', O: 'TestOrg', C: 'US' },
    issuerKey: caKeys,
    subjectKey: intKeys,
    isCA: true,
    serial: 2,
  });

  // Signer certificate
  const signerCert = buildCert({
    subject: { CN: 'Test Signer', O: 'TestOrg', C: 'US' },
    issuer: { CN: 'Test Intermediate CA', O: 'TestOrg', C: 'US' },
    issuerKey: intKeys,
    subjectKey: signerKeys,
    isCA: false,
    serial: 3,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 1, value: 'signer@test.local' }] }],
  });

  // Mock HSM certificate (self-signed for tests)
  const hsmCert = buildCert({
    subject: { CN: 'Mock HSM Signer', O: 'TestOrg', C: 'US' },
    issuer: { CN: 'Mock HSM Signer', O: 'TestOrg', C: 'US' },
    issuerKey: hsmKeys,
    subjectKey: hsmKeys,
    isCA: false,
    serial: 4,
  });

  console.log('Writing PEM files...');

  // Write CA files
  fs.writeFileSync(path.join(FIXTURES, 'ca.key'), forge.pki.privateKeyToPem(caKeys.privateKey));
  fs.writeFileSync(path.join(FIXTURES, 'ca.crt'), forge.pki.certificateToPem(caCert));

  // Write intermediate files
  fs.writeFileSync(path.join(FIXTURES, 'intermediate.key'), forge.pki.privateKeyToPem(intKeys.privateKey));
  fs.writeFileSync(path.join(FIXTURES, 'intermediate.crt'), forge.pki.certificateToPem(intCert));

  // Write signer files
  fs.writeFileSync(path.join(FIXTURES, 'signer.key'), forge.pki.privateKeyToPem(signerKeys.privateKey));
  fs.writeFileSync(path.join(FIXTURES, 'signer.crt'), forge.pki.certificateToPem(signerCert));

  // Write mock HSM files
  fs.writeFileSync(path.join(FIXTURES, 'mock-hsm-key.pem'), forge.pki.privateKeyToPem(hsmKeys.privateKey));
  fs.writeFileSync(path.join(FIXTURES, 'mock-hsm-cert.pem'), forge.pki.certificateToPem(hsmCert));

  console.log('Creating PKCS#12 bundles...');

  // signer-with-chain.p12 (signer + intermediate + root)
  const p12WithChain = forge.pkcs12.toPkcs12Asn1(
    signerKeys.privateKey,
    [signerCert, intCert, caCert],
    'testpassword123',
    { algorithm: '3des' },
  );
  fs.writeFileSync(
    path.join(FIXTURES, 'signer-with-chain.p12'),
    Buffer.from(forge.asn1.toDer(p12WithChain).getBytes(), 'binary'),
  );

  // signer-cert-only.p12 (signer cert only, no chain)
  const p12CertOnly = forge.pkcs12.toPkcs12Asn1(
    signerKeys.privateKey,
    [signerCert],
    'testpassword123',
    { algorithm: '3des' },
  );
  fs.writeFileSync(
    path.join(FIXTURES, 'signer-cert-only.p12'),
    Buffer.from(forge.asn1.toDer(p12CertOnly).getBytes(), 'binary'),
  );

  console.log('Generating sample.pdf...');
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Page 1
  const page1 = pdfDoc.addPage([612, 792]);
  page1.drawText('Test PDF — Page 1', { x: 50, y: 720, size: 24, font, color: rgb(0, 0, 0) });
  page1.drawText('This document is used for testing the pdf-signer library.', {
    x: 50, y: 680, size: 12, font, color: rgb(0.3, 0.3, 0.3),
  });
  page1.drawText('Signature field will be placed below:', { x: 50, y: 620, size: 12, font, color: rgb(0, 0, 0) });
  page1.drawRectangle({
    x: 50, y: 540, width: 250, height: 60,
    borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 1,
  });

  // Page 2
  const page2 = pdfDoc.addPage([612, 792]);
  page2.drawText('Test PDF — Page 2', { x: 50, y: 720, size: 24, font, color: rgb(0, 0, 0) });
  page2.drawText('Continuation page for multi-page signature tests.', {
    x: 50, y: 680, size: 12, font, color: rgb(0.3, 0.3, 0.3),
  });

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(path.join(FIXTURES, 'sample.pdf'), Buffer.from(pdfBytes));
  console.log(`sample.pdf created (${pdfBytes.length} bytes)`);

  // Write SVG fixture
  const svgContent = `<svg viewBox="0 0 300 80" xmlns="http://www.w3.org/2000/svg">
  <path d="M10,60 C30,20 50,20 70,50 C90,80 110,10 130,40 C150,70 170,30 190,45 C210,60 220,40 240,35 C260,30 270,50 285,45"
    stroke="#1a1a2e" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M10,65 L285,65" stroke="#1a1a2e" fill="none" stroke-width="0.5" opacity="0.4"/>
</svg>`;
  fs.writeFileSync(path.join(FIXTURES, 'sample-signature.svg'), svgContent);

  console.log('\nAll fixtures generated:');
  fs.readdirSync(FIXTURES).forEach(f => {
    const stat = fs.statSync(path.join(FIXTURES, f));
    console.log(`  ${f} (${stat.size} bytes)`);
  });

  console.log('\nRun tests with: npm test');
}

main().catch(err => {
  console.error('Error generating fixtures:', err);
  process.exit(1);
});
