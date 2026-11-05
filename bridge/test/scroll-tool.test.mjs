// scroll tool: structure checks on extension/content.js plus behavioural checks of the self-contained
// scroll core (findScrollTarget, scrollPage) run in a vm sandbox against a hand-built fake DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "..", "..", "extension", "content.js"), "utf8");
const core = src.slice(src.indexOf("// SCROLL-CORE-START"), src.indexOf("// SCROLL-CORE-END"));
const sandbox = vm.createContext({});
vm.runInContext(core + "\nthis.findScrollTarget = findScrollTarget; this.scrollPage = scrollPage;", sandbox);
const { findScrollTarget, scrollPage } = sandbox;

test("content.js scroll section has the new structure", () => {
  assert.ok(core.length > 500, "scroll core markers present");
  assert.ok(src.includes("Could not scroll "));
  assert.ok(src.includes('behavior: "instant"'));
  assert.ok(src.includes("shadowRoot"));
  assert.ok(src.includes("scrollPage(document, window, dir, isOwnUi, sleep)"));
  assert.ok(!src.includes("scrollBestInnerAt"));
  assert.ok(src.includes("Scrolled [\" + r.id + \"] into view."), "ref branch unchanged");
});

// ---- fake DOM ----
const VW = 1000, VH = 800;
function scroller({ overflowY = "auto", scrollHeight = 3000, clientHeight = 600, scrollTop = 0, rect = [0, 100, 1000, 700], shadowRoot = null, id = "" } = {}) {
  const el = {
    overflowY, scrollHeight, clientHeight, scrollTop, shadowRoot, id, parentNode: null,
    getBoundingClientRect: () => ({ left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }),
    scrollTo(o) { el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, o.top)); },
  };
  return el;
}
function makeWorld({ htmlOverflow = "visible", pageScrollHeight = VH, bodyOverflow = "visible", bodyScrollHeight = VH, others = [], stack = [], shadow = [] } = {}) {
  const win = {
    innerWidth: VW, innerHeight: VH, scrollY: 0,
    getComputedStyle: (el) => ({ overflowY: el.overflowY || "visible" }),
    scrollTo(o) { se.scrollTop = Math.max(0, Math.min(se.scrollHeight - VH, o.top)); win.scrollY = se.scrollTop; },
  };
  const se = scroller({ overflowY: htmlOverflow, scrollHeight: pageScrollHeight, clientHeight: VH });
  const body = scroller({ overflowY: bodyOverflow, scrollHeight: bodyScrollHeight, clientHeight: VH });
  const all = [se, body, ...others];
  const doc = {
    documentElement: se, scrollingElement: se, body,
    elementsFromPoint: () => stack,
    querySelectorAll: () => all,
  };
  const shadowRoot = { elementsFromPoint: () => shadow, querySelectorAll: () => shadow };
  return { win, doc, se, body, shadowRoot };
}
const notOwn = () => false;
const noSleep = () => Promise.resolve();

test("page scroller is picked when it can move", () => {
  const w = makeWorld({ pageScrollHeight: 3000 });
  assert.equal(findScrollTarget(w.doc, w.win, "down", notOwn).kind, "page");
});

test("body is picked when the page cannot move (boxed mode, html overflow hidden)", () => {
  const w = makeWorld({ htmlOverflow: "hidden", pageScrollHeight: 3000, bodyOverflow: "auto", bodyScrollHeight: 3000 });
  const t = findScrollTarget(w.doc, w.win, "down", notOwn);
  assert.equal(t.kind, "body");
  assert.equal(t.el, w.body);
});

test("inner pane under the centre is picked", () => {
  const pane = scroller({ rect: [100, 100, 900, 700] });
  const small = scroller({ rect: [0, 0, 200, 160], clientHeight: 160, scrollHeight: 900 });
  const w = makeWorld({ others: [small, pane], stack: [pane] });
  const t = findScrollTarget(w.doc, w.win, "down", notOwn);
  assert.equal(t.kind, "inner");
  assert.equal(t.el, pane);
});

test("inner pane inside an open shadow root is found", () => {
  const pane = scroller({ rect: [0, 0, 1000, 800] });
  const hostEl = { shadowRoot: null, overflowY: "visible", scrollHeight: 10, clientHeight: 10, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1, bottom: 1 }) };
  const w = makeWorld({ stack: [hostEl] });
  hostEl.shadowRoot = w.shadowRoot;
  w.shadowRoot.elementsFromPoint = () => [pane];
  const t = findScrollTarget(w.doc, w.win, "down", notOwn);
  assert.equal(t.el, pane);
  // also found by the bounded scan when the point probes miss it
  const w2 = makeWorld({ stack: [] });
  const host2 = { shadowRoot: { querySelectorAll: () => [pane] }, overflowY: "visible", scrollHeight: 1, clientHeight: 1 };
  w2.doc.querySelectorAll = () => [host2];
  assert.equal(findScrollTarget(w2.doc, w2.win, "down", notOwn).el, pane);
});

test("an element at its limit is skipped in that direction", () => {
  const atBottom = scroller({ scrollTop: 2400, rect: [0, 0, 1000, 800] });
  const other = scroller({ scrollTop: 0, rect: [0, 0, 500, 300], clientHeight: 300, scrollHeight: 1500 });
  const w = makeWorld({ others: [atBottom, other], stack: [atBottom] });
  assert.equal(findScrollTarget(w.doc, w.win, "down", notOwn).el, other);
  assert.equal(findScrollTarget(w.doc, w.win, "up", notOwn).el, atBottom);
});

test("own UI and tiny panes are never picked", () => {
  const mine = scroller({ id: "claude-safari-root" });
  const tiny = scroller({ clientHeight: 100, scrollHeight: 900 });
  const w = makeWorld({ others: [mine, tiny], stack: [mine, tiny] });
  assert.equal(findScrollTarget(w.doc, w.win, "down", (el) => el === mine), null);
});

test("scrollPage moves the target and reports which one", async () => {
  const w = makeWorld({ pageScrollHeight: 3000 });
  const r = await scrollPage(w.doc, w.win, "down", notOwn, noSleep);
  assert.match(r.text, /^Scrolled down \(page\)\. page scrollTop=640 scrollHeight=3000; window\.scrollY=640/);
  const b = await scrollPage(w.doc, w.win, "bottom", notOwn, noSleep);
  assert.match(b.text, /scrollTop=2200/);
  const t = await scrollPage(w.doc, w.win, "top", notOwn, noSleep);
  assert.match(t.text, /scrollTop=0/);

  const pane = scroller({ rect: [0, 0, 1000, 800] });
  const w2 = makeWorld({ others: [pane], stack: [pane] });
  const r2 = await scrollPage(w2.doc, w2.win, "down", notOwn, noSleep);
  assert.match(r2.text, /^Scrolled down \(inner pane\)\. inner scrollTop=480 scrollHeight=3000/);
});

test("unmovable page yields the Could not scroll error", async () => {
  const w = makeWorld();
  const r = await scrollPage(w.doc, w.win, "down", notOwn, noSleep);
  assert.ok(r.error.startsWith("Could not scroll down: nothing moved (tried: window, body, inner). "));
  assert.ok(r.error.includes("window.scrollY=0"));
  // a target is picked but the scroll call does nothing: still reported as not moved
  const pane = scroller({ rect: [0, 0, 1000, 800] });
  pane.scrollTo = () => {};
  const w2 = makeWorld({ others: [pane], stack: [pane] });
  const r2 = await scrollPage(w2.doc, w2.win, "down", notOwn, noSleep);
  assert.ok(r2.error.startsWith("Could not scroll down: nothing moved"));
});
