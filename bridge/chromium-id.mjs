#!/usr/bin/env node
// Derives the stable Chrome extension ID (and its origin) from the public key in tools/chromium-extension-key.txt.
// Chrome's rule: sha256 of the DER public key, first 16 bytes, each hex digit mapped to a-p.
// CLI: `node bridge/chromium-id.mjs` prints the origin only (chrome-extension://<id>). Built-ins only.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_KEY_FILE = path.join(here, "..", "tools", "chromium-extension-key.txt");

// base64Der: the base64 text of the DER SubjectPublicKeyInfo (the value of the manifest "key" field).
export function extensionIdFromKey(base64Der) {
  const der = Buffer.from(String(base64Der).trim(), "base64");
  if (der.length === 0) throw new Error("empty public key");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  let id = "";
  for (const ch of hex) id += String.fromCharCode(97 + parseInt(ch, 16));
  return id;
}

export function chromiumExtensionOrigin(keyFile = DEFAULT_KEY_FILE) {
  const key = fs.readFileSync(keyFile, "utf8").trim();
  if (!key) throw new Error(`key file is empty: ${keyFile}`);
  return `chrome-extension://${extensionIdFromKey(key)}`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    console.log(chromiumExtensionOrigin(process.argv[2] || DEFAULT_KEY_FILE));
  } catch (e) {
    console.error(`chromium-id: ${e.message}`);
    process.exit(1);
  }
}
