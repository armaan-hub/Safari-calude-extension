// Page intelligence (fit-judgment spec section 3): the page-brief procedure in the bridge prompt and the
// built-in extension prompt, and the three panel buttons in content.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SAFARI_ONLY_PROMPT } from "../claude-bridge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const bgFile = path.join(root, "extension", "background.js");
const contentFile = path.join(root, "extension", "content.js");
const bgSource = readFileSync(bgFile, "utf8");
const contentSource = readFileSync(contentFile, "utf8");

test("SAFARI_ONLY_PROMPT has the page-brief sentence and stays plain ASCII", () => {
  assert.ok(SAFARI_ONLY_PROMPT.includes("Page brief:"));
  assert.ok(SAFARI_ONLY_PROMPT.includes("profile_lookup results"));
  assert.ok(SAFARI_ONLY_PROMPT.indexOf("Page brief:") < SAFARI_ONLY_PROMPT.indexOf("Navigation is limited"));
  assert.match(SAFARI_ONLY_PROMPT, /^[\x20-\x7e]*$/, "prompt must be printable ASCII");
  assert.ok(!SAFARI_ONLY_PROMPT.includes('"'), "no double quotes");
  assert.ok(!SAFARI_ONLY_PROMPT.includes("\\"), "no backslashes");
  assert.ok(!/[{}]/.test(SAFARI_ONLY_PROMPT), "no curly braces");
});

test("extension/background.js built-in prompt has the page-brief bullet", () => {
  assert.ok(bgSource.includes("Page brief:"));
  assert.ok(bgSource.indexOf("Page brief:") < bgSource.indexOf("- Be concise."));
});

test("extension/content.js has the three page buttons and their instructions", () => {
  assert.ok(contentSource.includes("Summarize page"));
  assert.ok(contentSource.includes("Key details"));
  assert.ok(contentSource.includes("Is this for me"));
  assert.ok(contentSource.includes("Summarize this page: what it is, the key facts, and what I can do here."));
  assert.ok(contentSource.includes("List the key details on this page (names, numbers, dates, prices, links) as a short list."));
  assert.ok(contentSource.includes("Is this page good for me? Compare it with what you know about me and say why or why not."));
  assert.ok(contentSource.includes("page-actions"));
});

for (const file of [bgFile, contentFile]) {
  test(`syntax check passes for ${path.basename(file)}`, () => {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  });
}
