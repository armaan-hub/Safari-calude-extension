// content takeover: the guard prelude at the top of extension/content.js must refuse to double-load next to a
// LIVE copy, and take over (removing the orphan's claude-safari- elements) from a DEAD or OLD copy.
// The prelude is extracted from the real source text and run in a vm sandbox with fake window/document/browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "..", "..", "extension", "content.js"), "utf8");

// Prelude = from the opening `(() => {` through the end of the `window.__claudeSafariAlive = ...;` statement.
const start = src.indexOf("(() => {");
const aliveDef = src.indexOf("window.__claudeSafariAlive = ");
const end = src.indexOf("};", aliveDef) + 2;
const prelude = src.slice(start, end);
// The prelude leaves its IIFE open; close it after a marker that only runs if the guard did not return.
const TERMINAL_LINE = 'const BUILD_VARIANT = "terminal";';
assert.ok(prelude.includes(TERMINAL_LINE), "BUILD_VARIANT line (patched by build-safari.sh) is in the prelude");
const programFor = (variant) =>
  prelude.replace(TERMINAL_LINE, `const BUILD_VARIANT = "${variant}";`) + "\nwindow.__loaded = true;\n})();";

// A fake DOM: real elements with ids, a working getElementById, and remove() that marks the element removed.
function fakeEl(id) {
  return {
    id,
    removed: false,
    removeCalls: 0,
    remove() {
      this.removed = true;
      this.removeCalls += 1;
    },
  };
}

// Runs the prelude in a fresh sandbox. `preset` seeds window state (old/live copy markers).
function load({ runtimeId = "ext-id", preset = {}, variant = "terminal" } = {}) {
  const lookups = [];
  const els = [
    fakeEl("claude-safari-root"),
    fakeEl("claude-safari-root-panel"),
    fakeEl("claude-safari-status"),
    fakeEl("claude-safari-status-panel"),
    fakeEl("claude-safari-pointer"),
    fakeEl("claude-safari-pointer-panel"),
    fakeEl("other-id"),
  ];
  const byId = (id) => els.find((e) => e.id === id && !e.removed) || null;
  const browser = { runtime: {} };
  Object.defineProperty(browser.runtime, "id", {
    value: runtimeId,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  const document = {
    getElementById(id) {
      lookups.push(id);
      return byId(id);
    },
    querySelectorAll() {
      throw new Error("takeover must not sweep by id prefix");
    },
  };
  const win = { ...preset };
  const ctx = { window: win, document, browser };
  vm.createContext(ctx);
  vm.runInContext(programFor(variant), ctx);
  const removed = els.filter((e) => e.removed).map((e) => e.id);
  return { ctx, win, browser, els, lookups, removed };
}

test("fresh page: loads and installs a working alive check", () => {
  const { win, browser, lookups, removed } = load({ runtimeId: "ext-id" });
  assert.equal(win.__loaded, true);
  assert.equal(win.__claudeSafari, true);
  assert.equal(typeof win.__claudeSafariAlive, "function");
  assert.equal(win.__claudeSafariAlive(), true);
  browser.runtime.id = undefined;
  assert.equal(win.__claudeSafariAlive(), false);
  assert.deepEqual(lookups, [], "a fresh page never looks up (or removes) any element");
  assert.deepEqual(removed, []);
});

test("live copy present: second load returns early and touches nothing", () => {
  const live = () => true;
  const { win, els, lookups } = load({
    preset: { __claudeSafari: true, __claudeSafariAlive: live },
  });
  assert.deepEqual(lookups, [], "no lookups");
  assert.equal(win.__loaded, undefined, "guard returned, marker not set");
  assert.equal(win.__claudeSafariAlive, live, "live copy's function kept");
  assert.ok(els.every((e) => e.removeCalls === 0), "no elements removed");
});

test("terminal-variant takeover removes only the terminal ids", () => {
  const { win, removed, els } = load({ preset: { __claudeSafari: true } });
  assert.equal(win.__loaded, true);
  assert.equal(typeof win.__claudeSafariAlive, "function");
  assert.equal(win.__claudeSafariAlive(), true);
  assert.deepEqual(removed.sort(), ["claude-safari-pointer", "claude-safari-root", "claude-safari-status"]);
  for (const id of ["claude-safari-root-panel", "claude-safari-status-panel", "claude-safari-pointer-panel", "other-id"]) {
    assert.equal(els.find((e) => e.id === id).removeCalls, 0, id + " untouched");
  }
});

test("panel-variant takeover removes only the -panel ids", () => {
  const { win, removed, els } = load({ preset: { __claudeSafari: true }, variant: "panel" });
  assert.equal(win.__loaded, true);
  assert.deepEqual(removed.sort(), [
    "claude-safari-pointer-panel",
    "claude-safari-root-panel",
    "claude-safari-status-panel",
  ]);
  for (const id of ["claude-safari-root", "claude-safari-status", "claude-safari-pointer", "other-id"]) {
    assert.equal(els.find((e) => e.id === id).removeCalls, 0, id + " untouched");
  }
});

test("orphan whose alive function returns false: takes over", () => {
  const { win, removed } = load({
    preset: { __claudeSafari: true, __claudeSafariAlive: () => false },
  });
  assert.equal(win.__loaded, true);
  assert.ok(removed.includes("claude-safari-root"));
  assert.equal(win.__claudeSafariAlive(), true, "new alive function installed");
});

test("orphan whose alive function throws: takes over", () => {
  const { win, removed } = load({
    preset: {
      __claudeSafari: true,
      __claudeSafariAlive: () => {
        throw new Error("extension context invalidated");
      },
    },
  });
  assert.equal(win.__loaded, true);
  assert.ok(removed.includes("claude-safari-status"));
  assert.equal(typeof win.__claudeSafariAlive, "function");
});

test("content.js structure: prelude defines the alive check and the guard marker", () => {
  assert.ok(prelude.includes("window.__claudeSafariAlive = "), "alive check defined in the prelude");
  assert.ok(src.includes("window.__claudeSafari = true"), "marker still set");
  assert.equal(src.split("const api = ").length - 1, 1, "single api declaration");
  assert.ok(
    prelude.indexOf("const api = ") < prelude.indexOf("if (window.__claudeSafari)"),
    "api declared before the guard"
  );
});
