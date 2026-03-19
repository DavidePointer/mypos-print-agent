#!/usr/bin/env node
/**
 * Genera un'icona placeholder per il Print Agent.
 * Sostituisci assets/icon.ico con la tua icona definitiva prima del build.
 * 
 * Per generare una .ico professionale:
 *   1. Crea un PNG 256x256 con il logo Pointer/MyPos
 *   2. Convertilo su https://icoconvert.com/
 *   3. Sostituisci assets/icon.ico
 */

const fs = require("fs");
const path = require("path");

// ICO header minimo 16x16 pixel (nero con bordo bianco) - placeholder
// In produzione sostituire con icona vera
const ICO_PLACEHOLDER = Buffer.from(
  "000001000100101000000100200068040000160000002800000010000000200000000100200000000000000400000000000000000000000000000000000000" +
  "ffffffff".repeat(256) +
  "00000000".repeat(256),
  "hex"
);

const assetsDir = path.join(__dirname, "assets");
const iconPath = path.join(assetsDir, "icon.ico");

if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

if (!fs.existsSync(iconPath)) {
  // Crea un file ICO minimo valido
  fs.writeFileSync(iconPath, Buffer.from([
    0x00, 0x00, // Reserved
    0x01, 0x00, // Type: ICO
    0x01, 0x00, // Count: 1 image
    0x10,       // Width: 16
    0x10,       // Height: 16
    0x00,       // Color count
    0x00,       // Reserved
    0x01, 0x00, // Planes
    0x20, 0x00, // Bit count: 32
    0x28, 0x04, 0x00, 0x00, // Size of image data
    0x16, 0x00, 0x00, 0x00, // Offset
  ]));
  console.log("✅ Icona placeholder creata in assets/icon.ico");
  console.log("⚠️  Sostituisci con l'icona definitiva prima del build!");
} else {
  console.log("✅ Icona già presente in assets/icon.ico");
}
