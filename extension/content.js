// Claude for Safari — content script: the panel UI and the page "hands".
// Plain JS, no libraries. Model and page text only ever reach the DOM through textContent.

(() => {
  "use strict";
  if (window.__claudeSafari) return;
  window.__claudeSafari = true;

  const api = typeof browser !== "undefined" ? browser : chrome;
  // Window mode (PLAN T12a): panel.html sets this before this script runs. The panel then fills its own
  // window, is always shown, and gets its messages from the background over the "claude-panel" port.
  const WINDOW_MODE = window.__CLAUDE_WINDOW_MODE__ === true;
  let panelPort = null;
  // True once the panel has been built and attached. Terminal mode (PLAN T13b) never sets it on a page.
  let panelMode = false;
  const DEFAULT_MODEL = "claude-sonnet-5-5";
  // "terminal" or "panel". build-safari.sh patches this line per variant (PLAN T15). Terminal keeps the names
  // below as they are; the panel build suffixes its page-visible ids so both copies can share one page.
  const BUILD_VARIANT = "terminal";
  const ID_SUFFIX = BUILD_VARIANT === "panel" ? "-panel" : "";
  const HOST_ID = "claude-safari-root" + ID_SUFFIX;
  const READ_CAP = 40000;
  const TEXT_CAP = 30000;
  const STALE_MSG = "Unknown or stale ref. Call read_page again.";
  const DECLINED_MSG = "User declined this action.";
  const BUSY_MSG = "Another action is already waiting for approval.";
  const SENSITIVE_MSG = "Refusing to type into a sensitive field. Ask the user to fill it.";

  const RISKY = /\b(post|publish|send|submit|share|delete|remove|buy|pay|purchase|order|checkout|confirm|connect|follow|unfollow|apply|transfer|sign out|log out)\b/;
  const TIMEOUT_MSG = "No answer from user; action not taken.";
  const UNAVAILABLE_MSG = "Can't ask for approval right now; action not taken.";
  const APPROVAL_TIMEOUT_MS = 120000;
  // Tested against text with _ - . [ ] and camelCase boundaries turned into spaces (see isSensitiveText).
  const SENSITIVE_NAME = /\b(?:password|passcode|passwd|card ?number|cvv|cvc|2fa|otp|one time)\b/i;
  const SENSITIVE_AUTOCOMPLETE = /password|one-time|cc-number|cc-csc/;
  const isSensitiveText = (s) =>
    SENSITIVE_NAME.test(
      String(s == null ? "" : s)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_\-.\[\]]+/g, " ")
    );
  const INTERACTIVE_SEL = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=textbox]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=option]",
    "[role=combobox]",
    "[role=switch]",
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
    "[onclick]",
  ].join(", ");
  const TEXT_SEL = "p, li, span, td, th, h4, h5, h6, blockquote, dd, dt, figcaption, label, div";
  const LEAF_BLOCKERS = TEXT_SEL + ", ul, ol, table, tr, section, article, header, footer, nav, aside, main, h1, h2, h3, pre, form";
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD"]);
  const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color", "hidden"]);
  const LANDMARK_ROLES = new Set(["navigation", "main", "complementary", "form", "dialog", "search", "banner", "contentinfo"]);
  const LANDMARK_TAGS = { NAV: "navigation", MAIN: "main", ASIDE: "complementary", FORM: "form", DIALOG: "dialog" };
  const NAMED_KEYS = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Esc: { key: "Escape", code: "Escape", keyCode: 27 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Space: { key: " ", code: "Space", keyCode: 32, printable: true },
    " ": { key: " ", code: "Space", keyCode: 32, printable: true },
  };

  // Static panel stylesheet. Contains no dynamic data.
  // Dark is the default look; light mode only swaps the palette variables.
  const PANEL_CSS = `
*{box-sizing:border-box}
.panel{--bg:#1a1a19;--surface:#262624;--border:#3a3a37;--text:#e8e6e3;--muted:#9a9893;--accent:#c96442;--accent-hi:#d97757;--ok:#4caf7a;--bad:#e5484d;position:absolute;top:0;right:0;bottom:0;left:0;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;border-left:1px solid var(--border)}
button{font:inherit;cursor:pointer;border:none;color:inherit}
button svg{width:16px;height:16px;flex:none}
button:focus-visible,textarea:focus-visible{outline:2px solid var(--accent-hi);outline-offset:1px}
.header{display:flex;justify-content:flex-end;align-items:center;padding:8px 10px;flex:none}
.hdr-btns{display:flex;gap:2px;align-items:center}
.menu-wrap{position:relative}
button.icon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border-radius:8px;background:transparent;color:var(--muted)}
button.icon:hover{background:var(--surface);color:var(--text)}
.menu{position:absolute;top:100%;right:0;margin-top:4px;min-width:150px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:4px;z-index:3;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.menu button{display:flex;width:100%;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;background:transparent;text-align:left;font-size:13px;color:var(--text)}
.menu button:hover{background:rgba(255,255,255,.07)}
.menu svg{width:14px;height:14px;color:var(--accent-hi)}
.menu button[aria-checked="false"] svg{visibility:hidden}
.empty{flex:1;display:flex;align-items:center;justify-content:center;min-height:0}
.empty svg{width:96px;height:96px}
.messages{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.msg{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.msg.user{align-self:flex-end;max-width:85%;background:var(--surface);color:var(--text);padding:8px 13px;border-radius:16px;border-bottom-right-radius:4px}
.msg.assistant{align-self:stretch;color:var(--text);font-family:ui-serif,Georgia,"Times New Roman",serif;font-size:15px;line-height:1.55;white-space:normal}
.md{overflow-wrap:anywhere;word-break:break-word}
.md p{margin:0 0 .7em}
.md p:last-child,.md ul:last-child,.md ol:last-child,.md blockquote:last-child,.md pre:last-child{margin-bottom:0}
.md ul,.md ol{margin:0 0 .7em;padding-left:1.4em}
.md li{margin:.15em 0}
.md-h{font-weight:700;margin:.6em 0 .3em}
.md-h1{font-size:17px}
.md-h2{font-size:16px}
.md-h3{font-size:15px}
.md code{font:13px/1.4 ui-monospace,Menlo,monospace;background:var(--surface);padding:1px 4px;border-radius:4px}
.md pre{margin:.5em 0;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:auto;max-height:360px}
.md pre code{display:block;background:none;padding:0;font-size:12.5px;white-space:pre;overflow-wrap:normal;word-break:normal}
.md blockquote{margin:.5em 0;padding-left:12px;border-left:3px solid var(--border);color:var(--muted)}
.md hr{border:none;border-top:1px solid var(--border);margin:.8em 0}
.md a{color:var(--accent-hi);text-decoration:underline}
.md strong{font-weight:700}
.md-plain{white-space:pre-wrap}
details.tool>summary,details.toolerr>summary{cursor:pointer;list-style:none}
details.tool>summary::-webkit-details-marker,details.toolerr>summary::-webkit-details-marker{display:none}
.tool-detail{margin:4px 0 2px;padding:6px 8px;background:var(--surface);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;color:inherit;opacity:.85}
.tool-mark{margin-left:6px;font-weight:700}.tool-mark.run{color:#D97757}.tool-mark.ok{color:#5cb870}.tool-mark.bad{color:#e57373}
.thinking{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);font-style:italic}
.thinking svg{width:16px;height:16px;flex:none;animation:claude-spin 2.4s linear infinite}
@keyframes claude-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.thinking svg{animation:none}}
.strip{display:none;flex:1;flex-direction:column;align-items:center;justify-content:space-between;width:100%;box-sizing:border-box;padding:12px 0;background:var(--bg);cursor:pointer}
.panel.collapsed>:not(.strip){display:none!important}
.panel.collapsed>.strip{display:flex}
.strip>svg{width:22px;height:22px;flex:none}
.strip .run-dot{display:none;width:8px;height:8px;border-radius:50%;background:#D97757}
.strip.running .run-dot{display:block;animation:cs-pulse 1.2s ease-in-out infinite}
@keyframes cs-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.25)}}
@media (prefers-reduced-motion: reduce){.strip.running .run-dot{animation:none;opacity:1}}
.tool{font:12px/1.4 ui-monospace,Menlo,monospace;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.toolerr{font:12px/1.4 ui-monospace,Menlo,monospace;color:#ff8a80;white-space:pre-wrap;overflow-wrap:anywhere}
.status{font-style:italic;color:var(--muted);font-size:12px;white-space:pre-wrap}
.error{background:#3a1c1c;color:#ffb4ab;border:1px solid #6b2e2e;border-radius:10px;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere}
.busy{flex:none;padding:0 16px 6px;font-size:12px;color:var(--muted);font-style:italic}
.approval{flex:none;display:flex;flex-direction:column;gap:8px;margin:0 12px 8px;padding:10px 12px;background:#33291a;color:#f3dfb0;border:1px solid #5c4b10;border-radius:12px}
.approval-text{font-weight:600;overflow-wrap:anywhere}
.approval-actions{display:flex;gap:8px;justify-content:flex-end}
.composer{flex:none;padding:8px 12px 12px}
.card{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:10px 12px 8px;display:flex;flex-direction:column;gap:6px}
.card textarea{width:100%;min-height:44px;max-height:220px;resize:none;background:transparent;border:none;outline:none;color:var(--text);font:inherit;padding:2px}
.card textarea::placeholder{color:var(--muted)}
.card-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px}
button.pill{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border-radius:14px;background:transparent;color:var(--muted);font-size:13px}
button.pill:hover{background:rgba(255,255,255,.07);color:var(--text)}
button.pill svg{width:12px;height:12px}
.model-menu{top:auto;bottom:calc(100% + 6px);right:0;margin-top:0}
button.send{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--accent);color:#fff;padding:0}
button.send:hover{background:var(--accent-hi)}
button.send.stop{background:var(--text);color:var(--bg)}
button.send.stop svg{width:12px;height:12px}
.settings{flex:1;min-height:0;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px}
.section-title{font-weight:600;font-size:16px}
.field-label{font-size:12px;color:var(--muted);margin-top:6px}
.radio{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);cursor:pointer}
.radio input{accent-color:var(--accent);margin:0}
.bridge{display:flex;align-items:center;gap:8px;font-size:13px;padding:0 2px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex:none}
.dot.ok{background:var(--ok)}
.dot.bad{background:var(--bad)}
.key-field{display:flex;flex-direction:column;gap:6px}
.settings input[type=password]{width:100%;padding:9px 10px;font:inherit;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);outline:none}
.settings input[type=password]:focus{border-color:var(--accent-hi)}
.row-actions{display:flex;gap:8px;margin-top:10px}
button.primary{background:var(--accent);color:#fff;padding:8px 14px;border-radius:10px}
button.primary:hover{background:var(--accent-hi)}
button.ghost{background:var(--surface);color:var(--text);padding:8px 14px;border-radius:10px;border:1px solid var(--border)}
.note{font-size:12px;color:var(--muted)}
[hidden]{display:none !important}
.sub-head{display:flex;align-items:center;gap:6px;padding:0 10px 4px 6px;flex:none}
.sub-head .section-title{flex:1}
.sub-view{flex:1;min-height:0;overflow-y:auto;padding:8px 16px 18px;display:flex;flex-direction:column;gap:10px}
.list{display:flex;flex-direction:column;gap:6px}
.row{display:flex;align-items:center;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding-right:4px}
button.row-main{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:9px 10px;background:transparent;text-align:left;border-radius:10px;color:var(--text)}
button.row-main:hover{background:rgba(255,255,255,.05)}
.row-title{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.row-date{font-size:11px;color:var(--muted)}
.memory-text{width:100%;min-height:260px;resize:vertical;padding:10px 12px;font:13px/1.45 ui-monospace,Menlo,monospace;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);outline:none}
.memory-text:focus{border-color:var(--accent-hi)}
.cc-profile-title{font-size:12px;font-weight:600;color:var(--muted);margin:2px 0 6px}
.cc-profile{margin:0 0 12px;padding:10px 12px;max-height:180px;overflow:auto;white-space:pre-wrap;font:12px/1.45 ui-monospace,Menlo,monospace;color:var(--muted);border-radius:10px;border:1px dashed var(--border);background:var(--bg)}
.attach-list{display:flex;flex-wrap:wrap;gap:6px;padding:2px 2px 0}
.chip{display:flex;align-items:center;gap:6px;max-width:100%;padding:3px 3px 3px 3px;border:1px solid var(--border);border-radius:10px;background:var(--bg);font-size:12px}
.chip-thumb{width:28px;height:28px;object-fit:cover;border-radius:6px;flex:none}
.chip-name{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button.icon.chip-x{width:22px;height:22px}
.tab-group{flex:none;margin:0 12px 8px;padding:8px 10px;border:1px solid var(--border);border-radius:12px;background:var(--surface)}
.tab-group[hidden]{display:none}
.tab-group-label{font-size:11px;color:var(--muted);margin-bottom:6px}
.tab-group-chips{display:flex;flex-wrap:wrap;gap:6px}
.tab-chip{max-width:100%;padding:4px 10px;border:1px solid var(--border);border-radius:999px;background:var(--bg);color:var(--text);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.work-line{flex:none;margin:0 12px 8px;padding:6px 10px;border:1px solid var(--accent);border-radius:12px;background:var(--surface);font-size:12px;color:var(--text);overflow-wrap:anywhere}
.work-line[hidden]{display:none}
.work-tab{display:inline;padding:0;border:0;background:none;color:var(--accent-hi);font:inherit;font-weight:600;text-decoration:underline;cursor:pointer}
.tab-chip.working{border-color:var(--accent);color:var(--accent-hi);font-weight:600}
.attach-note{font-size:12px;color:var(--bad);overflow-wrap:anywhere}
.att-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;justify-content:flex-end}
.att{display:flex;align-items:center;gap:6px;max-width:100%;padding:3px 8px 3px 3px;border-radius:8px;background:var(--bg);border:1px solid var(--border);font-size:12px}
.att-thumb{width:32px;height:32px;object-fit:cover;border-radius:6px;flex:none}
.att-name{overflow-wrap:anywhere}
.card-foot .attach{margin-right:auto}
.skill-chips{display:flex;flex-wrap:wrap;gap:6px;padding:2px 2px 0}
.skill-chips[hidden]{display:none}
.skill-chip{max-width:100%;color:var(--accent-hi);font-weight:600}
.skill-chip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;padding-left:4px}
.slash-menu{top:auto;bottom:calc(100% + 6px);left:0;right:0;margin-top:0;min-width:0;max-height:300px;overflow-y:auto;padding:4px}
.slash-menu button{flex-direction:column;align-items:flex-start;gap:1px;min-width:0}
.slash-menu button.active{background:rgba(255,255,255,.07)}
.skill-name{font-weight:600;font-size:13px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slash-note{padding:8px 10px;font-size:12px;color:var(--muted)}
.skill-desc{font-size:12px;color:var(--muted);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skill-row{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:9px 10px;cursor:pointer}
.skill-row input{accent-color:var(--accent);margin:0;flex:none}
.skill-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.drop-hint{position:absolute;top:8px;right:8px;bottom:8px;left:8px;border:2px dashed var(--accent-hi);border-radius:16px;display:flex;align-items:center;justify-content:center;background:rgba(201,100,66,.12);color:var(--text);font-weight:600;pointer-events:none;z-index:4}
@media (prefers-color-scheme: light){
.panel{--bg:#faf9f5;--surface:#f0eee6;--border:#dcd9d0;--text:#1f1e1d;--muted:#6f6d68;--accent:#c96442;--accent-hi:#d97757}
.menu{box-shadow:0 8px 24px rgba(0,0,0,.12)}
.menu button:hover{background:rgba(0,0,0,.05)}
.slash-menu button.active{background:rgba(0,0,0,.05)}
button.pill:hover{background:rgba(0,0,0,.06)}
button.send.stop{background:var(--text);color:#faf9f5}
.toolerr{color:#c62828}
.error{background:#fdecea;color:#8e1b1b;border-color:#f5c2c0}
.approval{background:#fff7e0;color:#4a3800;border-color:#e6d18a}
.settings input[type=password]{background:#fff}
}
`;

  // ---------- small helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const errText = (e) => (e && e.message) || String(e);
  const ind = (d) => "  ".repeat(Math.min(d, 4));
  const normRef = (ref) => String(ref == null ? "" : ref).replace(/[\[\]\s]/g, "");
  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const send = (msg) => {
    try {
      return Promise.resolve(api.runtime.sendMessage(msg));
    } catch (e) {
      return Promise.reject(e);
    }
  };

  // ---------- markdown (safe subset) ----------
  // mdParse is pure (strings in, plain objects out, no DOM) so it can be tested in isolation.
  // renderMarkdown builds nodes with createElement + textContent only. Links are created
  // only for http: / https: URLs, and the href is assigned after checking the protocol.
  const MD_MAX_DEPTH = 6;
  const SAFE_PROTOCOLS = new Set(["http:", "https:"]);
  const isWordChar = (c) => !!c && /[A-Za-z0-9_]/.test(c);

  function safeUrl(raw) {
    try {
      const u = new URL(String(raw));
      return SAFE_PROTOCOLS.has(u.protocol) ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  // Index of the closing delimiter `ch` after `from`, or -1. Used for single-char emphasis.
  function mdFindClose(s, from, ch) {
    for (let j = from + 1; j < s.length; j++) {
      if (s[j] === ch && !/\s/.test(s[j - 1]) && !(ch === "_" && isWordChar(s[j + 1]))) return j;
    }
    return -1;
  }

  // [text](url) starting at index i. Returns { node, next } or null.
  function mdLink(s, i, depth) {
    const close = s.indexOf("]", i + 1);
    if (close < 0 || s[close + 1] !== "(") return null;
    const end = s.indexOf(")", close + 2);
    if (end < 0) return null;
    const label = s.slice(i + 1, close);
    if (label.indexOf("[") >= 0) return null;
    const url = s.slice(close + 2, end).trim().split(/\s+/)[0] || "";
    const raw = s.slice(i, end + 1);
    if (!safeUrl(url)) return { node: { t: "text", v: raw }, next: end + 1 };
    return { node: { t: "a", url, c: mdInline(label, depth + 1) }, next: end + 1 };
  }

  function mdInline(s, depth) {
    if (depth > MD_MAX_DEPTH) return [{ t: "text", v: s }];
    const out = [];
    let buf = "";
    const flush = () => {
      if (buf) out.push({ t: "text", v: buf });
      buf = "";
    };
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\n") {
        flush();
        out.push({ t: "br" });
        i++;
        continue;
      }
      if (ch === "`") {
        const end = s.indexOf("`", i + 1);
        if (end > i + 1 && s.slice(i + 1, end).indexOf("\n") < 0) {
          flush();
          out.push({ t: "code", v: s.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
      if (ch === "[") {
        const m = mdLink(s, i, depth);
        if (m) {
          flush();
          out.push(m.node);
          i = m.next;
          continue;
        }
      }
      if ((ch === "*" || ch === "_") && s[i + 1] === ch && !isWordChar(s[i - 1])) {
        const end = s.indexOf(ch + ch, i + 2);
        if (end > i + 2) {
          flush();
          out.push({ t: "b", c: mdInline(s.slice(i + 2, end), depth + 1) });
          i = end + 2;
          continue;
        }
      }
      if ((ch === "*" || ch === "_") && s[i + 1] !== ch && s[i + 1] && !/\s/.test(s[i + 1]) && !isWordChar(s[i - 1])) {
        const end = mdFindClose(s, i + 1, ch);
        if (end > i + 1) {
          flush();
          out.push({ t: "i", c: mdInline(s.slice(i + 1, end), depth + 1) });
          i = end + 1;
          continue;
        }
      }
      buf += ch;
      i++;
    }
    flush();
    return out;
  }

  const MD_LI = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  // Reads one list starting at lines[start]. One nesting level (indent of 2+ spaces).
  function mdList(lines, start, depth) {
    const first = MD_LI.exec(lines[start]);
    const ordered = /^\d/.test(first[2]);
    const items = [];
    let last = null;
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      const m = MD_LI.exec(line);
      if (m) {
        const isOrd = /^\d/.test(m[2]);
        const indent = m[1].replace(/\t/g, "  ").length;
        if (indent >= 2 && last) {
          if (!last.sub) last.sub = { ordered: isOrd, items: [] };
          last.sub.items.push({ c: mdInline(m[3], depth + 1) });
        } else {
          if (isOrd !== ordered) break;
          last = { c: mdInline(m[3], depth + 1), sub: null };
          items.push(last);
        }
        i++;
        continue;
      }
      if (/^\s*$/.test(line)) {
        let j = i + 1;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        if (j < lines.length && MD_LI.test(lines[j])) {
          i = j;
          continue;
        }
        break;
      }
      if (last && /^\s{2,}\S/.test(line)) {
        last.c = last.c.concat([{ t: "br" }], mdInline(line.trim(), depth + 1));
        i++;
        continue;
      }
      break;
    }
    return { block: { t: "list", ordered, start: ordered ? parseInt(first[2], 10) || 1 : 1, items }, next: i };
  }

  function mdBlocks(src, depth) {
    if (depth > MD_MAX_DEPTH) return [{ t: "p", c: [{ t: "text", v: src }] }];
    const lines = src.split("\n");
    const blocks = [];
    const para = [];
    const flushPara = () => {
      if (para.length) blocks.push({ t: "p", c: mdInline(para.splice(0).join("\n"), depth + 1) });
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (/^\s*$/.test(line)) {
        flushPara();
        i++;
        continue;
      }
      if ((m = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line))) {
        flushPara();
        const close = new RegExp("^\\s*" + m[1][0] + "{" + m[1].length + ",}\\s*$");
        const body = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++;
        blocks.push({ t: "code", text: body.join("\n") });
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara();
        blocks.push({ t: "hr" });
        i++;
        continue;
      }
      if ((m = /^\s{0,3}(#{1,3})\s+(.*?)(?:\s+#+)?\s*$/.exec(line))) {
        flushPara();
        blocks.push({ t: "h", level: m[1].length, c: mdInline(m[2], depth + 1) });
        i++;
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        flushPara();
        const inner = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
          inner.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
          i++;
        }
        blocks.push({ t: "quote", c: mdBlocks(inner.join("\n"), depth + 1) });
        continue;
      }
      if (MD_LI.test(line)) {
        flushPara();
        const r = mdList(lines, i, depth + 1);
        blocks.push(r.block);
        i = r.next;
        continue;
      }
      para.push(line);
      i++;
    }
    flushPara();
    return blocks;
  }

  function mdParse(text) {
    return mdBlocks(String(text == null ? "" : text).replace(/\r\n?/g, "\n"), 0);
  }

  function mdRenderInline(nodes, parent) {
    for (const n of nodes) {
      if (n.t === "text") parent.appendChild(document.createTextNode(n.v));
      else if (n.t === "br") parent.appendChild(document.createElement("br"));
      else if (n.t === "code") parent.appendChild(make("code", null, n.v));
      else if (n.t === "b" || n.t === "i") {
        const el = make(n.t === "b" ? "strong" : "em");
        mdRenderInline(n.c, el);
        parent.appendChild(el);
      } else if (n.t === "a") {
        const href = safeUrl(n.url);
        if (!href) {
          mdRenderInline(n.c, parent);
          continue;
        }
        const a = make("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        mdRenderInline(n.c, a);
        parent.appendChild(a);
      }
    }
  }

  function mdRenderItems(items, list) {
    for (const it of items) {
      const li = make("li");
      mdRenderInline(it.c, li);
      if (it.sub) {
        const sub = make(it.sub.ordered ? "ol" : "ul");
        mdRenderItems(it.sub.items, sub);
        li.appendChild(sub);
      }
      list.appendChild(li);
    }
  }

  function mdRenderBlocks(blocks, parent) {
    for (const b of blocks) {
      if (b.t === "p") {
        const el = make("p");
        mdRenderInline(b.c, el);
        parent.appendChild(el);
      } else if (b.t === "h") {
        const el = make("div", "md-h md-h" + b.level);
        mdRenderInline(b.c, el);
        parent.appendChild(el);
      } else if (b.t === "code") {
        const pre = make("pre");
        pre.appendChild(make("code", null, b.text));
        parent.appendChild(pre);
      } else if (b.t === "hr") {
        parent.appendChild(make("hr"));
      } else if (b.t === "quote") {
        const el = make("blockquote");
        mdRenderBlocks(b.c, el);
        parent.appendChild(el);
      } else if (b.t === "list") {
        const el = make(b.ordered ? "ol" : "ul");
        if (b.ordered) el.start = b.start;
        mdRenderItems(b.items, el);
        parent.appendChild(el);
      }
    }
  }

  // Never throws: on any failure the raw text is shown as plain pre-wrapped text.
  function renderMarkdown(text) {
    const wrap = make("div", "md");
    try {
      mdRenderBlocks(mdParse(text), wrap);
    } catch (e) {
      wrap.textContent = "";
      wrap.className = "md md-plain";
      wrap.textContent = String(text == null ? "" : text);
    }
    return wrap;
  }

  // ---------- panel (open shadow root, isolated from page CSS) ----------

  const NS = "http://www.w3.org/2000/svg";
  // Fixed icon path data. Static strings only; nothing dynamic goes into SVG markup.
  const ICON_PLUS = ["M12 5v14", "M5 12h14"];
  const ICON_MORE = ["M5 12h.01", "M12 12h.01", "M19 12h.01"];
  const ICON_CLOSE = ["M6 6l12 12", "M18 6L6 18"];
  const ICON_CHEVRON_RIGHT = ["M9 6l6 6-6 6"];
  const ICON_CHEVRON_LEFT = ["M15 6l-6 6 6 6"];
  const ICON_UP = ["M12 19V5", "M5 12l7-7 7 7"];
  const ICON_SQUARE = ["M7 7h10v10H7z"];
  const ICON_CHEVRON = ["M6 9l6 6 6-6"];
  const ICON_CHECK = ["M5 12l4 4 9-9"];
  const ICON_CLOCK = ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", "M12 7v5l3 2"];
  const ICON_BACK = ["M15 18l-6-6 6-6"];
  const ICON_CLIP = ["M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"];
  const ICON_FILE = ["M14 3H6v18h12V7z", "M14 3v4h4"];
  // Attachment limits (PLAN T9). Sizes in bytes.
  const MAX_ATTACHMENTS = 5;
  const MB = 1024 * 1024;
  const LIMIT_BYTES = { image: 5 * MB, pdf: 10 * MB, text: 500 * 1024 };
  const LIMIT_LABEL = { image: "5 MB", pdf: "10 MB", text: "500 KB" };
  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json"];
  const TEXT_EXT = /\.(txt|md|csv|json)$/i;
  const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf,.txt,.md,.csv,.json";
  // The pill shows the label; storage keeps the model id.
  const MODELS = [
    { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "claude-opus-5-5", label: "Opus 5.5" },
  ];

  function icon(paths, opts) {
    const o = opts || {};
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (o.fill) {
      svg.setAttribute("fill", "currentColor");
    } else {
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", o.width || "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
    }
    for (const d of paths) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }
  // Orange starburst for the empty state (fixed geometry, computed here).
  function starburstSvg() {
    // Same geometry as draw_spark() in tools/make-icons.py, drawn at R = 48 in the -50..50 viewBox.
    const R = 48;
    const RAY_LENGTHS = [1.0, 0.80, 0.92, 0.76, 0.98, 0.84, 0.94, 0.74, 1.0, 0.82, 0.90, 0.78];
    const ANGLE_JITTER_DEG = [2.5, -3.5, 1.0, 4.0, -2.0, 3.0, -4.0, 1.5, -1.0, 3.5, -3.0, 0.5];
    const BASE_HALF = R * 0.088;
    const TIP_HALF = R * 0.056;
    const R0 = R * 0.15;
    const HUB = R * 0.16;
    const SPARK = "#D97757";
    const f = (n) => n.toFixed(2);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "-50 -50 100 100");
    svg.setAttribute("aria-hidden", "true");
    for (let i = 0; i < RAY_LENGTHS.length; i++) {
      const a = ((i * 30 + ANGLE_JITTER_DEG[i] - 90) * Math.PI) / 180;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const px = -uy;
      const py = ux;
      const tipDist = R * RAY_LENGTHS[i] - TIP_HALF;
      const tx = ux * tipDist;
      const ty = uy * tipDist;
      const bx = ux * R0;
      const by = uy * R0;
      const poly = document.createElementNS(NS, "polygon");
      poly.setAttribute(
        "points",
        [
          "0,0",
          f(bx + px * BASE_HALF) + "," + f(by + py * BASE_HALF),
          f(tx + px * TIP_HALF) + "," + f(ty + py * TIP_HALF),
          f(tx - px * TIP_HALF) + "," + f(ty - py * TIP_HALF),
          f(bx - px * BASE_HALF) + "," + f(by - py * BASE_HALF),
        ].join(" ")
      );
      poly.setAttribute("fill", SPARK);
      svg.appendChild(poly);
      const cap = document.createElementNS(NS, "circle");
      cap.setAttribute("cx", f(tx));
      cap.setAttribute("cy", f(ty));
      cap.setAttribute("r", f(TIP_HALF));
      cap.setAttribute("fill", SPARK);
      svg.appendChild(cap);
    }
    const hub = document.createElementNS(NS, "circle");
    hub.setAttribute("cx", "0");
    hub.setAttribute("cy", "0");
    hub.setAttribute("r", f(HUB));
    hub.setAttribute("fill", SPARK);
    svg.appendChild(hub);
    return svg;
  }
  function iconButton(paths, label, opts) {
    const b = make("button", "icon");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.appendChild(icon(paths, opts));
    return b;
  }
  function radioOption(value, text) {
    const label = make("label", "radio");
    const input = make("input");
    input.type = "radio";
    input.name = "backend";
    input.value = value;
    label.append(input, make("span", null, text));
    return { label, input };
  }

  // Window mode starts hidden so a collapsed dock doesn't flash expanded; the first dockState (or 1.5 s) reveals it.
  function revealWindowHost() {
    host.style.visibility = "visible";
  }
  // PLAN T18: where popovers exist, the panel, status and pointer hosts are manual popovers. A popover sits in the top
  // layer, so it is not clipped by or moved with a transformed <html> (boxed mode). Without popovers nothing changes;
  // the docked window page (WINDOW_MODE) never boxes anything and keeps the old plain hosts.
  const POPOVER_OK = !WINDOW_MODE && typeof HTMLElement === "function" && typeof HTMLElement.prototype.showPopover === "function";
  const POPOVER_CSS = POPOVER_OK ? "inset:auto;margin:0;border:0;padding:0;overflow:visible;background:transparent;max-height:none;" : "";
  function popoverOpen(el) {
    if (!POPOVER_OK || !el) return;
    try {
      if (el.matches(":popover-open")) return;
    } catch (_) {}
    try {
      el.showPopover();
    } catch (_) {}
  }
  function popoverClose(el) {
    if (!POPOVER_OK || !el) return;
    try {
      if (el.matches(":popover-open")) el.hidePopover();
    } catch (_) {}
  }
  const host = document.createElement("div");
  host.id = HOST_ID;
  if (POPOVER_OK) host.setAttribute("popover", "manual");
  host.style.cssText = POPOVER_CSS + (WINDOW_MODE
    ? "position:fixed;top:0;left:0;width:100%;height:100%;display:block;visibility:hidden;"
    : "position:fixed;top:0;right:0;height:100vh;width:420px;z-index:2147483647;display:none;");
  const shadow = host.attachShadow({ mode: "open" });

  const wrap = make("div", "panel");
  const styleEl = make("style");
  styleEl.textContent = PANEL_CSS;

  // Header: small icon buttons only.
  const header = make("div", "header");
  const hdrBtns = make("div", "hdr-btns");
  const historyBtn = iconButton(ICON_CLOCK, "History");
  const newBtn = iconButton(ICON_PLUS, "New chat");
  const menuWrap = make("div", "menu-wrap");
  const menuBtn = iconButton(ICON_MORE, "More", { width: "3" });
  menuBtn.setAttribute("aria-haspopup", "menu");
  menuBtn.setAttribute("aria-expanded", "false");
  const menuEl = make("div", "menu");
  menuEl.setAttribute("role", "menu");
  menuEl.hidden = true;
  const settingsItem = make("button", null, "Settings");
  settingsItem.type = "button";
  settingsItem.setAttribute("role", "menuitem");
  const memoryItem = make("button", null, "Memory");
  memoryItem.type = "button";
  memoryItem.setAttribute("role", "menuitem");
  const skillsItem = make("button", null, "Skills");
  skillsItem.type = "button";
  skillsItem.setAttribute("role", "menuitem");
  const layoutItem = make("button", null, "Copy layout report");
  layoutItem.type = "button";
  layoutItem.setAttribute("role", "menuitem");
  menuEl.append(settingsItem, memoryItem, skillsItem, layoutItem);
  menuWrap.append(menuBtn, menuEl);
  const closeBtn = iconButton(ICON_CLOSE, WINDOW_MODE ? "Close" : "Hide");
  // Window mode only: collapses the docked window to a strip (PLAN T12b).
  const collapseBtn = iconButton(ICON_CHEVRON_RIGHT, "Collapse");
  collapseBtn.hidden = !WINDOW_MODE;
  collapseBtn.addEventListener("click", () => sendDockCollapse(true));
  hdrBtns.append(collapseBtn, historyBtn, newBtn, menuWrap, closeBtn);
  header.append(hdrBtns);

  // Window mode, collapsed (PLAN T12b): a full-height strip with the starburst, a running dot and an expand button.
  // Shown only while wrap has the collapsed class. Clicking it expands the window.
  const stripEl = make("div", "strip");
  stripEl.title = "Expand Claude";
  stripEl.setAttribute("aria-label", "Expand Claude");
  const runDot = make("span", "run-dot");
  const expandBtn = iconButton(ICON_CHEVRON_LEFT, "Expand Claude");
  stripEl.append(starburstSvg(), runDot, expandBtn);
  stripEl.addEventListener("click", () => sendDockCollapse(false));
  // Window mode: asks the background to collapse or expand the docked window. A dropped port reconnects on its own.
  function sendDockCollapse(v) {
    if (v && !approvalEl.hidden) return; // never collapse over a waiting approval
    if (!panelPort) return;
    try {
      panelPort.postMessage({ type: "dockCollapse", collapsed: !!v });
    } catch (e) {
      // port gone: the reconnect restores it
    }
  }
  let collapsed = false;
  function applyCollapsed(v) {
    if (v && !approvalEl.hidden) v = false; // an approval is showing: stay expanded
    collapsed = !!v;
    wrap.classList.toggle("collapsed", collapsed);
  }

  const emptyEl = make("div", "empty");
  emptyEl.appendChild(starburstSvg());
  const messagesEl = make("div", "messages");
  // "Thinking…" line with an animated starburst. Shown while running; removed when an item arrives.
  const thinkingEl = make("div", "thinking");
  thinkingEl.append(starburstSvg(), make("span", null, "Thinking…"));

  const settingsEl = make("div", "settings");
  settingsEl.hidden = true;
  const radioSub = radioOption("subscription", "Claude subscription (Claude Code on this Mac)");
  const radioKey = radioOption("apikey", "Anthropic API key");
  radioSub.input.checked = true;
  const bridgeRow = make("div", "bridge");
  const bridgeDot = make("span", "dot");
  const bridgeText = make("span");
  bridgeRow.append(bridgeDot, bridgeText);
  const keyField = make("div", "key-field");
  keyField.hidden = true;
  const keyInput = make("input");
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  keyInput.placeholder = "Paste your API key";
  keyInput.setAttribute("aria-label", "Anthropic API key");
  const keyStatus = make("div", "note");
  keyField.append(keyInput, keyStatus);
  const saveBtn = make("button", "primary", "Save");
  saveBtn.type = "button";
  const backBtn = make("button", "ghost", "Back");
  backBtn.type = "button";
  const settingsStatus = make("div", "note");
  const rowActions = make("div", "row-actions");
  rowActions.append(backBtn, saveBtn);
  settingsEl.append(
    make("div", "section-title", "Settings"),
    make("div", "field-label", "Connection"),
    radioSub.label,
    bridgeRow,
    radioKey.label,
    keyField,
    rowActions,
    settingsStatus,
    make("div", "note", "Your key is stored only in this browser's extension storage.")
  );

  // History and Memory views (PLAN T9). Static nodes only; all chat and memory text goes through textContent.
  function subHead(title) {
    const head = make("div", "sub-head");
    const back = iconButton(ICON_BACK, "Back");
    head.append(back, make("div", "section-title", title));
    return { head, back };
  }
  const historyEl = make("div", "sub-view");
  historyEl.hidden = true;
  const historyHead = subHead("History");
  const historyList = make("div", "list");
  historyList.setAttribute("role", "list");
  const historyStatus = make("div", "note");
  historyEl.append(historyHead.head, historyList, historyStatus);

  const memoryEl = make("div", "sub-view");
  memoryEl.hidden = true;
  const memoryHead = subHead("Memory");
  const memoryNote = make("div", "note", "Things Claude remembers about you. Edit freely; saved by the Claude bridge on this Mac.");
  // Read-only Claude Code profile, shown above the editable memory (PLAN T10b).
  const ccTitle = make("div", "cc-profile-title", "From Claude Code");
  const ccProfile = make("div", "cc-profile", "");
  const memoryText = make("textarea", "memory-text");
  memoryText.setAttribute("aria-label", "Memory text");
  memoryText.spellcheck = false;
  const memorySave = make("button", "primary", "Save");
  memorySave.type = "button";
  const memoryStatus = make("div", "note");
  const memoryActions = make("div", "row-actions");
  memoryActions.append(memorySave);
  memoryEl.append(memoryHead.head, memoryNote, ccTitle, ccProfile, memoryText, memoryActions, memoryStatus);

  // Skills view (PLAN T11c): every Claude Code skill with a checkbox; checked = active in this chat.
  const skillsEl = make("div", "sub-view");
  skillsEl.hidden = true;
  const skillsHead = subHead("Skills");
  const skillsNote = make("div", "note", "Checked skills shape how Claude answers in this chat. Read from ~/.claude/skills.");
  const skillsList = make("div", "list");
  skillsList.setAttribute("role", "list");
  const skillsStatus = make("div", "note");
  skillsEl.append(skillsHead.head, skillsNote, skillsList, skillsStatus);

  // Chips for the chat's active skills, above the input (PLAN T11c).
  const skillChips = make("div", "skill-chips");
  skillChips.hidden = true;
  // "/" menu above the input (PLAN T11c).
  const slashMenu = make("div", "menu slash-menu");
  slashMenu.setAttribute("role", "listbox");
  slashMenu.hidden = true;

  const busyEl = make("div", "busy", "Claude is working…");
  busyEl.hidden = true;

  const approvalEl = make("div", "approval");
  approvalEl.hidden = true;
  const approvalText = make("div", "approval-text");
  const approvalAllow = make("button", "primary", "Allow");
  const approvalDeny = make("button", "ghost", "Deny");
  const approvalActions = make("div", "approval-actions");
  approvalActions.append(approvalDeny, approvalAllow);
  approvalEl.append(approvalText, approvalActions);

  // Composer: rounded card with the input, then a foot row (model pill, send).
  const composerEl = make("div", "composer");
  const card = make("div", "card");
  const inputEl = make("textarea");
  inputEl.rows = 2;
  inputEl.placeholder = "How can I help you today?";
  inputEl.setAttribute("aria-label", "Message");
  // Attachments: chips above the textarea, a paperclip in the foot row, and a hidden file input.
  const attachList = make("div", "attach-list");
  attachList.hidden = true;
  const attachNote = make("div", "attach-note");
  attachNote.hidden = true;
  const attachBtn = iconButton(ICON_CLIP, "Attach files", { width: "2" });
  attachBtn.classList.add("attach");
  const fileInput = make("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = ACCEPT;
  fileInput.hidden = true;
  fileInput.setAttribute("aria-hidden", "true");
  const foot = make("div", "card-foot");
  const modelBtn = make("button", "pill");
  modelBtn.type = "button";
  modelBtn.setAttribute("aria-haspopup", "menu");
  modelBtn.setAttribute("aria-expanded", "false");
  const modelLabel = make("span", null, "Sonnet 5.5");
  modelBtn.append(modelLabel, icon(ICON_CHEVRON, { width: "2.4" }));
  const modelMenu = make("div", "menu model-menu");
  modelMenu.setAttribute("role", "menu");
  modelMenu.hidden = true;
  const modelItems = MODELS.map((m) => {
    const btn = make("button");
    btn.type = "button";
    btn.setAttribute("role", "menuitemradio");
    btn.setAttribute("aria-checked", "false");
    btn.append(icon(ICON_CHECK, { width: "2.4" }), make("span", null, m.label));
    modelMenu.appendChild(btn);
    return { id: m.id, label: m.label, btn };
  });
  const sendBtn = make("button", "send");
  sendBtn.type = "button";
  const sendUp = icon(ICON_UP, { width: "2.4" });
  const stopSq = icon(ICON_SQUARE, { fill: true });
  stopSq.style.display = "none";
  sendBtn.append(sendUp, stopSq);
  foot.append(attachBtn, modelBtn, sendBtn);
  card.append(skillChips, attachList, attachNote, inputEl, foot, slashMenu, modelMenu, fileInput);
  composerEl.appendChild(card);

  const dropHint = make("div", "drop-hint", "Drop files to attach");
  dropHint.hidden = true;

  // ---------- Claude's tab group (PLAN T11a) ----------
  // The strip under the header: one chip per tab in the group. The working tab is highlighted.
  const tabGroupEl = make("div", "tab-group");
  tabGroupEl.hidden = true;
  const tabGroupChips = make("div", "tab-group-chips");
  tabGroupEl.append(make("div", "tab-group-label", "Claude's tabs"), tabGroupChips);
  function renderTabGroup(tabs) {
    tabGroupChips.textContent = "";
    const list = (Array.isArray(tabs) ? tabs : []).filter((t) => t && typeof t.tabId === "number");
    tabGroupEl.hidden = list.length === 0;
    for (const t of list) {
      const chip = make("button", "tab-chip", String(t.title || t.url || "Tab"));
      chip.type = "button";
      chip.title = String(t.url || "");
      if (t.working) {
        chip.classList.add("working");
        chip.setAttribute("aria-current", "true");
      }
      chip.addEventListener("click", () => {
        send({ type: "activateTab", tabId: t.tabId }).catch(() => {});
      });
      tabGroupChips.appendChild(chip);
    }
  }
  // Status line (PLAN T11b): while Claude works in another tab, the panel the user is looking at says where.
  // Built from textContent only. It hides itself if no update arrives (the background re-sends every ~5 s).
  const WORK_STALE_MS = 15000;
  const workLineEl = make("div", "work-line");
  workLineEl.hidden = true;
  const workTabBtn = make("button", "work-tab");
  workTabBtn.type = "button";
  const workLabelEl = make("span", null);
  workLineEl.append(make("span", null, "✦ Working in "), workTabBtn, workLabelEl);
  let workLineTab = null;
  let workLineTimer = null;
  workTabBtn.addEventListener("click", () => {
    if (workLineTab != null) send({ type: "activateTab", tabId: workLineTab }).catch(() => {});
  });
  function renderWorkLine(msg) {
    clearTimeout(workLineTimer);
    workLineTimer = null;
    if (!msg || msg.state !== "working" || msg.here || typeof msg.tabId !== "number") {
      workLineTab = null;
      workLineEl.hidden = true;
      return;
    }
    workLineTab = msg.tabId;
    workTabBtn.textContent = String(msg.title || "tab");
    workLabelEl.textContent = " — " + String(msg.label || "working");
    workLineEl.hidden = false;
    workLineTimer = setTimeout(() => renderWorkLine(null), WORK_STALE_MS);
  }
  // Tabs Claude opened carry a "✦ " title prefix. The observer re-applies it when the page changes its title.
  // The panel build uses its own mark. Both copies may mark one tab, so each looks for its mark only inside the
  // leading run of known marks ("✦ " or "◆ "): a copy that sees the other's mark in front still adds its own once, and
  // removal never touches the page's own text. A mark is removed only if this copy added it, so a title that
  // starts with the same symbol by itself is left alone.
  const GROUP_MARK = BUILD_VARIANT === "panel" ? "◆ " : "✦ ";
  const ALL_MARKS = ["✦ ", "◆ "]; // every mark is two UTF-16 units
  let groupOn = false;
  let groupAdded = false;
  function ownMarkAt(t) {
    for (let i = 0; ALL_MARKS.some((m) => t.startsWith(m, i)); i += 2) {
      if (t.startsWith(GROUP_MARK, i)) return i;
    }
    return -1;
  }
  function applyGroupTitle() {
    const t = document.title;
    if (groupOn) {
      if (ownMarkAt(t) < 0) {
        document.title = GROUP_MARK + t;
        groupAdded = true;
      }
    } else if (groupAdded) {
      groupAdded = false;
      const i = ownMarkAt(t);
      if (i >= 0) document.title = t.slice(0, i) + t.slice(i + GROUP_MARK.length);
    }
  }
  let titleObserver = null;
  function watchTitle() {
    const el = document.querySelector("title");
    if (!el) return;
    if (!titleObserver) titleObserver = new MutationObserver(() => applyGroupTitle());
    titleObserver.disconnect();
    titleObserver.observe(el, { childList: true, characterData: true, subtree: true });
  }
  // A page may replace its <title> element, so watch the head for that too.
  const headObserver = new MutationObserver(() => {
    watchTitle();
    applyGroupTitle();
  });
  function setTabMark(on) {
    groupOn = !!on;
    if (groupOn) {
      // observe() on an already-observed target just replaces the options, so repeat calls are safe
      headObserver.observe(document.head || document.documentElement, { childList: true });
      watchTitle();
      applyGroupTitle();
    } else {
      applyGroupTitle(); // removes the mark
      headObserver.disconnect();
      if (titleObserver) titleObserver.disconnect();
    }
  }

  wrap.append(header, tabGroupEl, workLineEl, emptyEl, messagesEl, settingsEl, historyEl, memoryEl, skillsEl, busyEl, approvalEl, composerEl, dropHint, stripEl);
  shadow.append(styleEl, wrap);

  // Keys typed into the panel must not reach the page.
  for (const type of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste"]) {
    wrap.addEventListener(type, (e) => e.stopPropagation());
  }

  // Side panel push (PLAN T9): the page is shifted left by the panel width while the panel is open.
  // The previous inline margin-right and transition are saved and restored on close.
  const PUSH_WIDTH = "420px";
  // Both copies (terminal and panel) may be open on one page and both push the same html margin. So the page keeps
  // the list of pushing copies in PUSH_OWNERS_ATTR (one token per copy: "terminal" or "panel"), and the margin and
  // transition as they were before the first push in PUSH_SAVED_ATTR. The margin is restored only when the last
  // copy closes. These two attribute names are shared by both builds on purpose, so they are not suffixed.
  const PUSH_OWNERS_ATTR = "data-claude-push";
  const PUSH_SAVED_ATTR = "data-claude-push-saved";
  let pagePush = false;
  function restoreProp(style, name, saved) {
    if (saved[0]) style.setProperty(name, saved[0], saved[1]);
    else style.removeProperty(name);
  }
  function pushOwners(el) {
    return (el.getAttribute(PUSH_OWNERS_ATTR) || "").split(" ").filter(Boolean);
  }
  function setPushOwners(el, owners) {
    if (owners.length) el.setAttribute(PUSH_OWNERS_ATTR, owners.join(" "));
    else el.removeAttribute(PUSH_OWNERS_ATTR);
  }
  // An owner counts only while its host element is on the page and open. A copy that was reloaded or removed
  // without closing leaves its token behind; such a token is dropped here instead of holding the margin.
  function ownerLive(variant) {
    const h = document.getElementById("claude-safari-root" + (variant === "panel" ? "-panel" : ""));
    return !!h && h.style.display === "block";
  }

  // Fit pass (PLAN T16): while this copy pushes the page, fixed bars and wide in-flow sections that reach into the
  // panel zone are shifted or narrowed so they stay clear of it. Only inline styles are written, each touched
  // property keeps its original value and priority, and fitStop puts them back exactly (a property the page has
  // rewritten since is left alone). Only the top frame fits; the docked window never pushes.
  //
  // Which side a fixed box hangs from cannot be read from stylesheets (a cross-origin CDN sheet throws on cssRules),
  // so it is measured: the box's `right` is bumped by a few px for one layout read and then restored on the spot.
  // The result is cached per element (WeakMap) and dropped when the element's class or style changes.
  const FIT_PUSH_PX = parseInt(PUSH_WIDTH, 10);
  const FIT_MAX_ELEMENTS = 10000;
  const FIT_DEBOUNCE_MS = 200;
  const FIT_LATE_MS = 1000;
  const FIT_PROBE_PX = 7;
  const FIT_SETTLE_RETRIES = 4;
  const FIT_OWN_SELECTOR = '[id^="claude-safari-"]';
  // el -> { props: {name: [value, priority]}, written: {name: value}, base: {name: original value}, hadStyle }
  // Kept in a Map because fitStop must walk it; fitPrune drops entries whose element is gone or hidden.
  const fitSaved = new Map();
  let fitAnchor = new WeakMap(); // el -> "right" | "stretch" | "left" | "none"
  let fitActive = false;
  let fitObserver = null;
  let fitTimer = 0;
  let fitLateTimer = 0;
  let fitLastMs = 0;
  let fitUnsettled = 0;
  // PLAN T18: covered-check timing and boxed mode state (see fitCheckCovered and enterBoxed).
  const COVER_FIRST_MS = 700;
  const COVER_GAP_MS = 1000;
  const BOXED_ATTR = "data-claude-boxed";
  let boxedOn = false;
  let boxedReason = null;
  let boxedStore = null;
  let coverTimer = 0;
  let coverLast = 0;
  let coverStreak = 0;
  function fitNum(v) {
    return v && v.slice(-2) === "px" ? parseFloat(v) : null;
  }
  function fitExtra(cs) {
    if (cs.boxSizing === "border-box") return 0;
    return (
      (parseFloat(cs.paddingLeft) || 0) +
      (parseFloat(cs.paddingRight) || 0) +
      (parseFloat(cs.borderLeftWidth) || 0) +
      (parseFloat(cs.borderRightWidth) || 0)
    );
  }
  // max-width never grows a box that the page itself caps lower: the page's own computed max-width stays in a min().
  function fitCap(value, authored) {
    return authored && authored !== "none" ? "min(" + authored + ", " + value + ")" : value;
  }
  function fitCleanAttr(el, had) {
    if (!had && el.hasAttribute("style") && el.style.length === 0) el.removeAttribute("style");
  }
  function fitOwns(el, e, name) {
    const st = el.style;
    return st.getPropertyValue(name) === e.written[name] && st.getPropertyPriority(name) === "important";
  }
  function fitWrite(el, e, name, value) {
    const st = el.style;
    if (!(name in e.props)) e.props[name] = [st.getPropertyValue(name), st.getPropertyPriority(name)];
    st.setProperty(name, value, "important");
    e.written[name] = st.getPropertyValue(name);
  }
  // Puts back every property that is still ours. A property the page has rewritten since belongs to the page.
  function fitRestoreEntry(el, e) {
    try {
      for (const name of Object.keys(e.props)) {
        if (fitOwns(el, e, name)) restoreProp(el.style, name, e.props[name]);
      }
      fitCleanAttr(el, e.hadStyle);
    } catch (_) {}
  }
  // Entries whose element left the page or is hidden are restored and dropped, so the Map cannot grow without bound
  // and a node the page later re-inserts does not carry our values. A property the page took over is forgotten.
  function fitPrune() {
    for (const [el, e] of fitSaved) {
      let drop = !el.isConnected;
      if (!drop) {
        try {
          for (const name of Object.keys(e.props)) {
            if (!fitOwns(el, e, name)) {
              delete e.props[name];
              delete e.written[name];
              delete e.base[name];
            }
          }
          if (!Object.keys(e.props).length) {
            fitSaved.delete(el);
            continue;
          }
          drop = el.getClientRects().length === 0;
        } catch (_) {
          drop = true;
        }
      }
      if (drop) {
        fitRestoreEntry(el, e);
        fitSaved.delete(el);
      }
    }
  }
  // Measures which side each fixed box hangs from: its `right` goes up by FIT_PROBE_PX, the rect is read, and the exact
  // original inline `right` (and `transition`, which is switched off so the nudge cannot animate) comes back. All
  // boxes are written, then all are read (one layout), then all are restored.
  //   right    rect.right moved, width kept  -> hangs from the right (also a centred box with auto margins)
  //   stretch  rect.right moved, width shrank -> stretched by left+right, or a shrink-wrapped left box
  //   left     rect.right did not move        -> hangs from the left
  function fitProbe(items) {
    const prev = [];
    try {
      for (const p of items) {
        const st = p.el.style;
        prev.push({
          p,
          had: p.el.hasAttribute("style"),
          right: [st.getPropertyValue("right"), st.getPropertyPriority("right")],
          transition: [st.getPropertyValue("transition"), st.getPropertyPriority("transition")],
          after: null,
        });
        st.setProperty("transition", "none", "important");
        st.setProperty("right", p.crNow + FIT_PROBE_PX + "px", "important");
      }
      for (const o of prev) {
        const r = o.p.el.getBoundingClientRect();
        o.after = { right: r.right, width: r.width };
      }
    } finally {
      for (const o of prev) {
        try {
          restoreProp(o.p.el.style, "right", o.right);
        } catch (_) {}
      }
      if (prev.length) {
        try {
          void prev[0].p.el.offsetWidth; // style is recalculated with transitions off before they are switched back on
        } catch (_) {}
      }
      for (const o of prev) {
        try {
          restoreProp(o.p.el.style, "transition", o.transition);
          fitCleanAttr(o.p.el, o.had);
        } catch (_) {}
      }
    }
    for (const o of prev) {
      if (!o.after) continue;
      const moved = o.after.right - o.p.E < -1;
      fitAnchor.set(o.p.el, moved ? (o.after.width - o.p.W < -1 ? "stretch" : "right") : "left");
    }
  }
  // True when an ancestor below <body> clips horizontally: a wide child there is cut off, not drawn under the panel.
  function fitClipped(el, cache) {
    const walked = [];
    let clipped = false;
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (cache.has(a)) {
        clipped = cache.get(a);
        break;
      }
      walked.push(a);
      if (getComputedStyle(a).overflowX !== "visible") {
        clipped = true;
        break;
      }
    }
    for (const a of walked) cache.set(a, clipped);
    return clipped;
  }
  function fitSchedule(delay) {
    if (!fitActive || fitTimer) return;
    // One pending pass at a time: a steady stream of page mutations still gets a pass every few hundred ms, and a slow
    // pass backs the next one off.
    fitTimer = setTimeout(() => {
      fitTimer = 0;
      fitPage();
    }, delay || Math.max(FIT_DEBOUNCE_MS, fitLastMs * 20));
  }
  // Changes made by our own style writes are drained at the end of each pass; changes inside our own hosts are ignored.
  function fitOnMutations(records) {
    let hit = false;
    for (const rec of records) {
      const t = rec.target;
      if (t && t.nodeType === 1) {
        if (t.closest && t.closest(FIT_OWN_SELECTOR)) continue;
        if (rec.type === "attributes") fitAnchor.delete(t);
      }
      hit = true;
    }
    if (hit) fitSchedule();
  }
  function fitPage() {
    if (!fitActive) return;
    const t0 = performance.now();
    try {
      const body = document.body;
      const root = document.documentElement;
      if (!body || !root) return;
      if (fitObserver) {
        for (const rec of fitObserver.takeRecords()) if (rec.type === "attributes") fitAnchor.delete(rec.target);
      }
      fitPrune();
      // Fixed boxes are placed against the layout viewport, whose width excludes a classic scrollbar (in quirks mode
      // only <body> reports it). The panel is a fixed box too, so the zone starts one panel width inside that edge.
      const fz = fitZone();
      const vw = fz.vw;
      const zone = fz.zone;
      if (!(zone > 0)) return;
      // The html margin eases in (transition), so until it has settled in-flow widths still show the old layout.
      const margin = parseFloat(getComputedStyle(root).marginRight);
      const settled = boxedOn || Math.abs(margin - FIT_PUSH_PX) < 1 || fitUnsettled >= FIT_SETTLE_RETRIES;
      if (!settled) fitUnsettled++;
      else fitUnsettled = 0;

      const els = body.getElementsByTagName("*");
      const n = Math.min(els.length, FIT_MAX_ELEMENTS);
      const clipCache = new Map();
      // Read phase: one computed style per element, and no writes until every candidate is measured.
      const plan = [];
      for (let i = 0; i < n; i++) {
        const el = els[i];
        const cs = getComputedStyle(el);
        const pos = cs.position;
        if (pos === "fixed") {
          // Boxed mode: fixed boxes end at the panel edge by themselves (html is their containing block), so they are not touched.
          if (boxedOn || cs.visibility === "hidden") continue;
          const r = el.getBoundingClientRect();
          if (!(r.width > 0) || !(r.right > zone + 0.5) || !(r.left < vw - 0.5)) continue;
          if (el.closest(FIT_OWN_SELECTOR)) continue;
          plan.push({
            el,
            kind: r.left < zone - 0.5 ? "span" : "inside",
            L: r.left,
            E: r.right,
            W: r.width,
            cl: fitNum(cs.left),
            cr: fitNum(cs.right),
            crNow: fitNum(cs.right),
            maxw: cs.maxWidth,
            extra: fitExtra(cs),
          });
        } else if (settled && parseFloat(cs.width) > zone + 1) {
          // In flow (or absolute): wider than the narrowed page, e.g. width:100vw.
          const r = el.getBoundingClientRect();
          if (!(r.width > zone + 1) || !(r.right > zone + 1)) continue;
          if (el.closest(FIT_OWN_SELECTOR)) continue;
          // A clipped box is normally left alone (carousel tracks), unless it is viewport-wide: LinkedIn-style wrappers
          // (width or min-width 100vw inside an overflow-x hidden/clip ancestor) centre their content on the full window.
          if (fitClipped(el, clipCache) && !(Math.abs(r.width - window.innerWidth) <= 2 || Math.abs(r.width - (zone + FIT_PUSH_PX)) <= 2)) continue;
          plan.push({ el, kind: "flow", L: r.left, absolute: pos === "absolute", maxw: cs.maxWidth, minw: cs.minWidth, extra: fitExtra(cs) });
        }
      }
      // Probe phase: only fixed boxes that have not been measured yet, and only when there are any.
      const probes = [];
      for (const p of plan) {
        if (p.kind === "flow" || fitAnchor.has(p.el)) continue;
        if (p.crNow === null) fitAnchor.set(p.el, "none");
        else probes.push(p);
      }
      if (probes.length) fitProbe(probes);
      // Write phase.
      for (const p of plan) {
        try {
          const el = p.el;
          let e = fitSaved.get(el);
          const put = (name, value) => {
            if (!e) {
              e = { props: {}, written: {}, base: {}, hadStyle: el.hasAttribute("style"), flow: p.kind === "flow" };
              fitSaved.set(el, e);
            }
            if (!(name in e.props)) e.base[name] = name === "right" ? p.cr : name === "left" ? p.cl : name === "min-width" ? p.minw : p.maxw;
            fitWrite(el, e, name, value);
          };
          // Originals: what the box had before our first write to that property (never drift on later passes).
          const orig = (name, cur) => (e && name in e.props ? e.base[name] : cur);
          const oRight = orig("right", p.cr);
          const oLeft = orig("left", p.cl);
          const oMax = orig("max-width", p.maxw);
          if (p.kind === "flow") {
            const cap = p.absolute ? Math.max(0, Math.floor(zone - p.L - p.extra)) + "px" : p.extra ? "calc(100% - " + p.extra + "px)" : "100%";
            put("max-width", fitCap(cap, oMax));
            // min-width beats max-width, so a min-width wider than the zone is capped as well.
            if (parseFloat(p.minw) > zone + 1) put("min-width", fitCap(cap, orig("min-width", p.minw)));
            continue;
          }
          const cls = fitAnchor.get(el) || "none";
          if (p.kind === "span") {
            if ((cls === "right" || cls === "stretch") && oRight !== null) {
              put("right", oRight + FIT_PUSH_PX + "px");
              // A stretched box is bounded by left+right already; a box with its own width also needs a cap so the
              // shifted box does not run off the left edge of the viewport.
              if (cls === "right") put("max-width", fitCap(Math.max(0, Math.floor(zone - oRight - p.extra)) + "px", oMax));
            } else {
              put("max-width", fitCap(Math.max(0, Math.floor(zone - p.L - p.extra)) + "px", oMax));
            }
          } else if (cls === "right" && oRight !== null) {
            put("right", oRight + FIT_PUSH_PX + "px");
          } else if (cls === "left" && oLeft !== null) {
            put("left", oLeft - FIT_PUSH_PX + "px");
          } else if (cls === "stretch" && oLeft !== null && oRight !== null) {
            put("left", oLeft - FIT_PUSH_PX + "px");
            put("right", oRight + FIT_PUSH_PX + "px");
          }
        } catch (_) {
          // One odd element must not stop the rest.
        }
      }
      // The records our own writes just queued are dropped, so they cannot schedule another pass.
      if (fitObserver) fitObserver.takeRecords();
      if (!settled) fitSchedule(250);
    } catch (_) {
      // A failed pass must never break the page or the panel.
    } finally {
      fitLastMs = performance.now() - t0;
      if (fitActive) fitCoverSoon();
    }
  }
  // Read-only diagnostic for PLAN T17a ("Copy layout report"). Writes no style or attribute on the page; the only
  // attribute values read are id and class, and no text content is read.
  function layoutRect(el) {
    const r = el.getBoundingClientRect();
    return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), t: Math.round(r.top) };
  }
  function layoutStyle(el) {
    const cs = getComputedStyle(el);
    return {
      position: cs.position,
      width: cs.width,
      minWidth: cs.minWidth,
      maxWidth: cs.maxWidth,
      left: cs.left,
      right: cs.right,
      marginLeft: cs.marginLeft,
      marginRight: cs.marginRight,
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      display: cs.display,
      height: cs.height
    };
  }
  function layoutPath(el) {
    const parts = [];
    let depth = 0;
    for (let a = el; a && a.nodeType === 1 && depth < 7; a = a.parentElement, depth++) {
      let s = a.tagName.toLowerCase();
      if (a.id) s += "#" + String(a.id).slice(0, 40);
      const cls = Array.from(a.classList).slice(0, 3).map((c) => c.slice(0, 40));
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  }
  function layoutDepth(el) {
    let n = 0;
    for (let a = el.parentElement; a; a = a.parentElement) n++;
    return n;
  }
  function layoutReport() {
    const body = document.body;
    const root = document.documentElement;
    const fz = fitZone();
    const vw = fz.vw;
    const zone = fz.zone;
    const report = {
      host: location.hostname,
      vw: { root: root.clientWidth, innerWidth: window.innerWidth, innerHeight: window.innerHeight },
      zone,
      fitActive,
      mode: boxedOn ? "boxed" : "push",
      boxedReason,
      fitSaved: fitSaved.size,
      pushAttr: root.getAttribute(PUSH_OWNERS_ATTR),
      root: { ...layoutStyle(root), rect: layoutRect(root) },
      body: { ...layoutStyle(body), rect: layoutRect(body) },
      wideTotal: 0,
      wide: []
    };
    const found = [];
    for (const el of body.querySelectorAll("*")) {
      if (el.closest(FIT_OWN_SELECTOR)) continue;
      const r = el.getBoundingClientRect();
      if (!(r.right > zone + 1 && r.width > 0 && r.top < window.innerHeight && r.bottom > 0)) continue;
      found.push({ el, depth: layoutDepth(el) });
    }
    found.sort((x, y) => x.depth - y.depth);
    report.wideTotal = found.length;
    for (const f of found.slice(0, 400)) {
      const el = f.el;
      report.wide.push({
        path: layoutPath(el),
        depth: f.depth,
        ...layoutStyle(el),
        rect: layoutRect(el),
        inFitSaved: fitSaved.has(el),
        anchor: fitAnchor.get(el) || null,
        clipped: fitClipped(el, new Map())
      });
    }
    return report;
  }
  async function copyLayoutReport() {
    let json = "";
    try {
      json = JSON.stringify(layoutReport(), null, 1);
    } catch (e) {
      addItem({ kind: "assistant", text: "Could not build the layout report (" + errText(e) + ")." });
      return;
    }
    try {
      await navigator.clipboard.writeText(json);
      addItem({ kind: "assistant", text: "Layout report copied — paste it to Claude." });
    } catch (e) {
      addItem({ kind: "assistant", text: "Could not copy (" + errText(e) + "). Report:\n```\n" + json + "\n```" });
    }
  }
  // PLAN T18 part B/C. The zone (where the panel starts) is measured in the normal way, or, while boxed, as the
  // width of the boxed <html> (the window's width minus the panel).
  function fitZone() {
    const body = document.body;
    const root = document.documentElement;
    if (boxedOn) return { vw: window.innerWidth, zone: root.clientWidth || window.innerWidth - FIT_PUSH_PX };
    const vw = Math.min(
      (document.compatMode === "BackCompat" ? body.clientWidth : root.clientWidth) || window.innerWidth,
      window.innerWidth
    );
    return { vw, zone: vw - FIT_PUSH_PX };
  }
  // Samples 3 columns (the panel's left edge, its middle and the window's right edge) by one row every 32 px (so a
  // thin bar is not missed). A sample hits when the topmost page element under it (not our hosts, not html or body)
  // really covers the point, is visible and is not a sliver (rect under 4 px wide or high is decorative overflow).
  function fitCheckCovered() {
    const root = document.documentElement;
    const vw = Math.min(root.clientWidth || window.innerWidth, window.innerWidth);
    const zone = vw - FIT_PUSH_PX;
    const h = window.innerHeight;
    const xs = [zone + 6, zone + FIT_PUSH_PX / 2, vw - 6];
    let hits = 0;
    let points = 0;
    let reason = null;
    for (const x of xs) {
      for (let y = 4; y <= h - 4; y += 32) {
        points++;
        const stack = document.elementsFromPoint(x, y) || [];
        for (const el of stack) {
          if (el.closest && el.closest(FIT_OWN_SELECTOR)) continue;
          if (el === root || el === document.body) break;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (r.width < 4 || r.height < 4) break;
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0) {
            hits++;
            if (!reason) reason = layoutPath(el);
          }
          break;
        }
      }
    }
    return { covered: hits >= 2, hits, points, reason };
  }
  function fitCoverRun() {
    coverTimer = 0;
    coverLast = performance.now();
    if (!fitActive || boxedOn || BUILD_VARIANT !== "panel") return;
    try {
      const margin = parseFloat(getComputedStyle(document.documentElement).marginRight);
      if (!(Math.abs(margin - FIT_PUSH_PX) < 1)) {
        coverStreak = 0;
        return;
      }
      const r = fitCheckCovered();
      if (!r.covered) {
        coverStreak = 0;
        return;
      }
      coverStreak++;
      if (coverStreak >= 2) {
        enterBoxed("covered: " + (r.reason || "overlay") + " (" + r.hits + " of " + r.points + " sample points)");
        return;
      }
      // One more check, so a single covered reading never switches the mode on its own.
      coverTimer = setTimeout(fitCoverRun, COVER_GAP_MS);
    } catch (_) {}
  }
  // At most one check per COVER_GAP_MS, scheduled from the end of each fit pass.
  function fitCoverSoon() {
    if (coverTimer || !fitActive || boxedOn || BUILD_VARIANT !== "panel") return;
    coverTimer = setTimeout(fitCoverRun, Math.max(0, COVER_GAP_MS - (performance.now() - coverLast)));
  }
  // Boxed mode: html gets a transform (its own containing block for fixed boxes), a width that stops at the panel,
  // and the page scrolls inside <body>. Every touched property keeps its exact prior inline value and priority.
  const BOX_ROOT_CSS = [
    ["transform", "translateZ(0)"],
    ["width", "calc(100% - " + PUSH_WIDTH + ")"],
    ["height", "100vh"],
    ["overflow", "hidden"],
    ["margin-right", "0px"],
    ["transition", "none"],
  ];
  const BOX_BODY_CSS = [
    ["height", "100%"],
    ["overflow", "auto"],
  ];
  function boxWrite(el, list, sub) {
    const st = el.style;
    for (const [name, value] of list) {
      if (!(name in sub.props)) sub.props[name] = [st.getPropertyValue(name), st.getPropertyPriority(name)];
      st.setProperty(name, value, "important");
      sub.written[name] = st.getPropertyValue(name);
    }
  }
  // Puts back only the properties that still hold our value; a value the page rewrote since belongs to the page.
  function boxRestore(el, sub) {
    const st = el.style;
    for (const name of Object.keys(sub.props)) {
      if (st.getPropertyValue(name) === sub.written[name] && st.getPropertyPriority(name) === "important") {
        restoreProp(st, name, sub.props[name]);
      }
    }
  }
  function enterBoxed(reason) {
    if (boxedOn || !fitActive) return;
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;
    const store = {
      root,
      body,
      rootSub: { props: {}, written: {} },
      bodySub: { props: {}, written: {} },
      hadRoot: root.hasAttribute("style"),
      hadBody: body.hasAttribute("style"),
      scrollY: window.scrollY || 0,
    };
    try {
      // Fixed boxes are put back to their own values; in-flow entries stay (they are still fitted while boxed).
      for (const [el, e] of fitSaved) {
        if (!e.flow) {
          fitRestoreEntry(el, e);
          fitSaved.delete(el);
        }
      }
      boxedStore = store;
      boxedOn = true;
      fitScrollOff();
      boxedReason = reason || null;
      root.setAttribute(BOXED_ATTR, "");
      boxWrite(root, BOX_ROOT_CSS, store.rootSub);
      boxWrite(body, BOX_BODY_CSS, store.bodySub);
      body.scrollTop = store.scrollY;
      if (fitObserver) fitObserver.takeRecords();
    } catch (_) {
      exitBoxed();
    }
  }
  function exitBoxed() {
    const store = boxedStore;
    if (!boxedOn && !store) return;
    boxedOn = false;
    boxedStore = null;
    let y = 0;
    try {
      y = store ? store.body.scrollTop : 0;
    } catch (_) {}
    if (store) {
      try {
        boxRestore(store.root, store.rootSub);
        boxRestore(store.body, store.bodySub);
        if (!store.hadRoot) fitCleanAttr(store.root, false);
        if (!store.hadBody) fitCleanAttr(store.body, false);
        store.root.removeAttribute(BOXED_ATTR);
      } catch (_) {}
      try {
        window.scrollTo(0, y);
      } catch (_) {}
    }
    if (fitObserver) {
      try {
        fitObserver.takeRecords();
      } catch (_) {}
    }
  }
  const fitOnResize = () => fitSchedule();
  // A box scrolled into view later (an absolute dock below the first screen) is only seen by a scroll-time check.
  // One capture-phase listener on window gets the window's scroll and every element's scroll; fitCoverSoon throttles
  // it to one check per COVER_GAP_MS. Push mode only: boxed entry and fitStop remove it.
  const fitOnScroll = () => fitCoverSoon();
  function fitScrollOff() {
    try {
      window.removeEventListener("scroll", fitOnScroll, true);
    } catch (_) {}
  }
  function fitStart() {
    if (fitActive || WINDOW_MODE) return;
    try {
      if (window.top !== window) return;
    } catch (_) {
      return;
    }
    fitActive = true;
    fitUnsettled = 0;
    coverStreak = 0;
    boxedReason = null;
    coverTimer = setTimeout(fitCoverRun, COVER_FIRST_MS);
    try {
      fitObserver = new MutationObserver(fitOnMutations);
      fitObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      window.addEventListener("resize", fitOnResize);
      window.addEventListener("scroll", fitOnScroll, { capture: true, passive: true });
    } catch (_) {
      // No observer: the first pass still runs.
    }
    fitPage();
    fitLateTimer = setTimeout(() => {
      fitLateTimer = 0;
      fitPage();
    }, FIT_LATE_MS);
  }
  function fitStop() {
    fitActive = false;
    try {
      exitBoxed();
    } catch (_) {}
    clearTimeout(coverTimer);
    coverTimer = 0;
    coverStreak = 0;
    clearTimeout(fitTimer);
    fitTimer = 0;
    clearTimeout(fitLateTimer);
    fitLateTimer = 0;
    try {
      window.removeEventListener("resize", fitOnResize);
    } catch (_) {}
    fitScrollOff();
    if (fitObserver) {
      try {
        fitObserver.disconnect();
      } catch (_) {}
      fitObserver = null;
    }
    for (const [el, e] of fitSaved) fitRestoreEntry(el, e);
    fitSaved.clear();
    fitAnchor = new WeakMap();
  }
  // Page hide or close releases the fit pass. A page restored from the back-forward cache starts it again if this
  // copy still has its push on.
  window.addEventListener("pagehide", () => fitStop());
  window.addEventListener("pageshow", () => {
    if (pagePush && !fitActive) fitStart();
  });

  function pushPage(on) {
    if (WINDOW_MODE) return; // the docked window never pushes the page
    const el = document.documentElement;
    if (!el) return;
    const s = el.style;
    const others = pushOwners(el).filter((o) => o !== BUILD_VARIANT && ownerLive(o));
    if (on) {
      if (pagePush) return;
      pagePush = true;
      // First copy to push remembers what the page had before. If the attribute is already there (a reloaded copy
      // left its push behind), it is kept: the margin on the page now is ours, not the page's.
      if (!el.hasAttribute(PUSH_SAVED_ATTR)) {
        el.setAttribute(
          PUSH_SAVED_ATTR,
          JSON.stringify({
            margin: [s.getPropertyValue("margin-right"), s.getPropertyPriority("margin-right")],
            transition: [s.getPropertyValue("transition"), s.getPropertyPriority("transition")],
            attr: el.hasAttribute("style"), // PLAN T18: a page with no style attribute gets none back
          })
        );
      }
      s.setProperty("transition", "margin-right .2s ease", "important");
      s.setProperty("margin-right", PUSH_WIDTH, "important");
      setPushOwners(el, [...others, BUILD_VARIANT]);
      fitStart();
    } else {
      if (!pagePush) return;
      pagePush = false;
      fitStop();
      setPushOwners(el, others);
      if (others.length) return; // the other copy is still open: it keeps the push
      let saved = null;
      try {
        saved = JSON.parse(el.getAttribute(PUSH_SAVED_ATTR) || "null");
      } catch (_) {
        saved = null;
      }
      el.removeAttribute(PUSH_SAVED_ATTR);
      if (saved && saved.margin && saved.transition) {
        restoreProp(s, "margin-right", saved.margin);
        restoreProp(s, "transition", saved.transition);
        if (saved.attr === false) fitCleanAttr(el, false);
      } else {
        s.removeProperty("margin-right");
        s.removeProperty("transition");
      }
    }
  }

  function show() {
    host.style.display = "block";
    popoverOpen(host);
    pushPage(true);
    syncOverlayLayout();
  }
  function hide() {
    if (WINDOW_MODE) return; // the docked window is always shown; it closes with ✕ or with its window
    host.style.display = "none";
    popoverClose(host);
    pushPage(false);
    syncOverlayLayout();
    closeMenus();
    // Hiding the panel while an approval is pending counts as Deny.
    resolveApproval(false);
  }
  function toggle() {
    if (host.style.display === "block") hide();
    else {
      show();
      inputEl.focus();
    }
  }

  let running = false;
  let stopRequested = false;
  function setRunning(v) {
    running = !!v;
    stripEl.classList.toggle("running", running); // the collapsed strip's dot pulses while the agent works
    busyEl.hidden = !running;
    // SVG elements have no .hidden property, so toggle the display style instead.
    sendUp.style.display = running ? "none" : "";
    stopSq.style.display = running ? "" : "none";
    sendBtn.classList.toggle("stop", running);
    sendBtn.title = running ? "Stop" : "Send";
    sendBtn.setAttribute("aria-label", running ? "Stop" : "Send");
    if (running) {
      if (!thinkingEl.isConnected) {
        messagesEl.appendChild(thinkingEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    } else {
      thinkingEl.remove();
    }
  }

  const ITEM_CLASS = {
    user: "msg user",
    assistant: "msg assistant",
    tool: "tool",
    toolerr: "toolerr",
    status: "status",
    error: "error",
  };
  // The empty state shows only when there is nothing in the conversation.
  // Which full-panel view shows: "chat" (default), "settings", "history" or "memory".
  let view = "chat";
  function setView(v) {
    view = v;
    settingsEl.hidden = v !== "settings";
    historyEl.hidden = v !== "history";
    memoryEl.hidden = v !== "memory";
    skillsEl.hidden = v !== "skills";
    refreshView();
  }
  function refreshView() {
    const inChat = view === "chat";
    const empty = inChat && messagesEl.childElementCount === 0;
    emptyEl.hidden = !empty;
    messagesEl.hidden = !inChat || empty;
    composerEl.hidden = !inChat;
  }
  // Friendly labels for the page tools (PLAN T7). Unknown names keep the raw text.
  const TOOL_LABELS = {
    read_page: "Read page",
    get_page_text: "Read page text",
    click: "Clicked",
    type: "Typed",
    press_key: "Pressed key",
    scroll: "Scrolled",
    navigate: "Opened",
    screenshot: "Took screenshot",
    wait: "Waited",
  };
  // Tool text from background.js describeTool is "name key=value ..."; the name is the first word.
  function toolLabel(raw) {
    const m = /^(\S+)/.exec(raw);
    const name = m ? m[1] : "";
    return Object.prototype.hasOwnProperty.call(TOOL_LABELS, name) ? TOOL_LABELS[name] : null;
  }
  // Live status on a tool line (PLAN T11b): "…" while running, ✓ or ✕ when the tool has answered.
  // lastToolMark is the mark of the newest running tool line; toolDone updates it.
  let lastToolMark = null;
  function setToolMark(mark, state) {
    mark.className = "tool-mark " + (state === "done" ? "ok" : state === "error" ? "bad" : "run");
    mark.textContent = state === "done" ? "✓" : state === "error" ? "✕" : "…";
  }
  // Collapsible line: the summary is the label, the detail is the raw text (plain textContent).
  // Items from the visible-actions build carry item.detail and item.state.
  function buildToolNode(kind, text, item) {
    if (kind === "tool" && item && typeof item.detail === "string") {
      const d = make("details", "tool");
      const mark = make("span", "tool-mark");
      const st = item.state;
      if (st === "running" && running) {
        setToolMark(mark, "running");
        lastToolMark = mark;
      } else if (st === "done" || st === "error") {
        setToolMark(mark, st);
      }
      const s = make("summary", null);
      s.append(make("span", null, text), mark);
      d.append(s, make("div", "tool-detail", item.detail));
      return d;
    }
    if (kind === "tool") {
      const label = toolLabel(text);
      if (!label) return make("div", "tool", text);
      const d = make("details", "tool");
      d.append(make("summary", null, label + " ›"), make("div", "tool-detail", text));
      return d;
    }
    const first = text.split("\n")[0].trim();
    const d = make("details", "toolerr");
    d.append(make("summary", null, (first ? clip(first, 100) : "Tool error") + " ›"), make("div", "tool-detail", text));
    return d;
  }
  function buildItemNode(kind, text, item) {
    if (kind === "assistant") {
      const node = make("div", ITEM_CLASS.assistant);
      node.appendChild(renderMarkdown(text));
      return node;
    }
    if (kind === "tool" || kind === "toolerr") return buildToolNode(kind, text, item);
    if (kind === "user") return buildUserNode(text, item);
    return make("div", ITEM_CLASS[kind], text);
  }
  // User bubble: the text, then the attachment names. A thumbnail shows only for a message sent
  // from this panel in this session (item.attachments[i].url); stored items have names only.
  function buildUserNode(text, item) {
    const node = make("div", ITEM_CLASS.user, text);
    const list = item && Array.isArray(item.attachments) ? item.attachments : [];
    if (!list.length) return node;
    const row = make("div", "att-list");
    for (const a of list) {
      if (!a || typeof a !== "object") continue;
      const chip = make("div", "att");
      if (a.kind === "image" && a.url) {
        const img = make("img", "att-thumb");
        img.alt = "";
        img.src = a.url;
        chip.appendChild(img);
      }
      chip.appendChild(make("span", "att-name", String(a.name || "file")));
      row.appendChild(chip);
    }
    node.appendChild(row);
    return node;
  }
  function addItem(item) {
    if (!item || !Object.prototype.hasOwnProperty.call(ITEM_CLASS, item.kind)) return;
    const text = String(item.text == null ? "" : item.text);
    thinkingEl.remove();
    messagesEl.appendChild(buildItemNode(item.kind, text, item));
    refreshView();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  // Object URLs behind thumbnails of bubbles on screen. Revoked when the transcript is rebuilt.
  let bubbleUrls = [];
  // Thumbnail URLs of the message being sent, matched to the next echoed "user" item.
  let echoThumbs = null;
  function revokeBubbleUrls() {
    for (const u of bubbleUrls) URL.revokeObjectURL(u);
    bubbleUrls = [];
  }
  function renderTranscript(list) {
    revokeBubbleUrls();
    messagesEl.textContent = "";
    for (const item of list || []) addItem(item);
    if (running) messagesEl.appendChild(thinkingEl);
    refreshView();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function handleUI(item) {
    if (!item || typeof item !== "object") return;
    if (item.kind === "toolDone") {
      if (lastToolMark) setToolMark(lastToolMark, item.ok ? "done" : "error");
      lastToolMark = null;
      return;
    }
    if (item.kind === "running") {
      setRunning(item.value);
      if (item.value) {
        stopRequested = false;
        show();
      }
      return;
    }
    if (item.kind === "user" && echoThumbs) {
      const thumbs = echoThumbs;
      echoThumbs = null;
      const atts = Array.isArray(item.attachments) ? item.attachments : [];
      item = { ...item, attachments: atts.map((a, i) => ({ ...(a || {}), url: thumbs[i] || null })) };
    }
    // Items are always appended; only errors reopen a panel the user may have hidden.
    addItem(item);
    if (item.kind === "error") show();
  }

  // ---------- menus and model pill ----------

  function setMenu(menu, btn, open) {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  }
  function closeMenus() {
    setMenu(menuEl, menuBtn, false);
    setMenu(modelMenu, modelBtn, false);
    closeSlash();
  }
  function setModelLabel(id) {
    const cur = MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === DEFAULT_MODEL) || MODELS[1];
    modelLabel.textContent = cur.label;
    for (const item of modelItems) item.btn.setAttribute("aria-checked", String(item.id === cur.id));
  }
  async function loadModel() {
    try {
      const got = await api.storage.local.get("model");
      setModelLabel(got && got.model);
    } catch (e) {
      setModelLabel(DEFAULT_MODEL);
    }
  }
  async function pickModel(id) {
    closeMenus();
    setModelLabel(id);
    try {
      await api.storage.local.set({ model: id });
    } catch (e) {
      addItem({ kind: "error", text: "Could not save model: " + errText(e) });
    }
  }

  // ---------- settings view ----------

  function selectedBackend() {
    return radioKey.input.checked ? "apikey" : "subscription";
  }
  let bridgeSeq = 0;
  function setBridgeState(state, text) {
    bridgeDot.className = state ? "dot " + state : "dot";
    bridgeText.textContent = text;
  }
  // Asks the background whether the local Claude Code bridge answers.
  async function checkBridge() {
    const seq = ++bridgeSeq;
    setBridgeState("", "Checking…");
    let r = null;
    try {
      r = await send({ type: "bridgeStatus" });
    } catch (e) {
      r = null;
    }
    if (seq !== bridgeSeq) return;
    if (r && r.ok) setBridgeState("ok", "Connected");
    else setBridgeState("bad", "Not running — in Terminal run: ~/claude-web-extension/bridge/install.sh");
  }
  // Shows the status line or the key field, depending on the chosen connection.
  function applyBackendView() {
    const sub = selectedBackend() === "subscription";
    bridgeRow.hidden = !sub;
    keyField.hidden = sub;
    if (sub) checkBridge();
  }
  radioSub.input.addEventListener("change", applyBackendView);
  radioKey.input.addEventListener("change", applyBackendView);

  async function openSettings() {
    closeMenus();
    keyInput.value = "";
    settingsStatus.textContent = "";
    setView("settings");
    let st = {};
    try {
      st = (await api.storage.local.get(["backend", "apiKey"])) || {};
    } catch (e) {
      settingsStatus.textContent = "Could not read settings: " + errText(e);
    }
    (st.backend === "apikey" ? radioKey : radioSub).input.checked = true;
    // The saved key is never shown; only whether one exists.
    keyStatus.textContent = st.apiKey ? "Key saved ✓" : "No key saved yet.";
    applyBackendView();
  }
  async function saveSettings() {
    const backend = selectedBackend();
    const data = { backend };
    const newKey = keyInput.value.trim();
    if (backend === "apikey" && newKey) data.apiKey = newKey;
    try {
      await api.storage.local.set(data);
      keyInput.value = "";
      const { apiKey } = await api.storage.local.get("apiKey");
      keyStatus.textContent = apiKey ? "Key saved ✓" : "No key saved yet.";
      settingsStatus.textContent = "Saved.";
      applyBackendView();
    } catch (e) {
      settingsStatus.textContent = "Save failed: " + errText(e);
    }
  }

  // ---------- history view (PLAN T9) ----------

  // Relative date for a chat's "updated" value (ms; seconds also accepted).
  function relTime(ts) {
    let t = Number(ts) || 0;
    if (t && t < 1e12) t *= 1000;
    if (!t) return "";
    const diff = Date.now() - t;
    const min = Math.round(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return min + " min ago";
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + " h ago";
    const days = Math.round(hr / 24);
    if (days === 1) return "yesterday";
    if (days < 7) return days + " days ago";
    return new Date(t).toLocaleDateString();
  }
  let historyLoadSeq = 0;
  async function loadHistory() {
    const seq = ++historyLoadSeq;
    historyList.textContent = "";
    historyStatus.textContent = "Loading…";
    let r = null;
    try {
      r = await send({ type: "listChats" });
    } catch (e) {
      r = { error: errText(e) };
    }
    if (seq !== historyLoadSeq) return;
    const chats = r && Array.isArray(r.chats) ? r.chats : [];
    historyStatus.textContent = r && r.error ? r.error : chats.length ? "" : "No saved chats yet.";
    for (const c of chats) {
      if (!c || typeof c.id !== "string") continue;
      const row = make("div", "row");
      row.setAttribute("role", "listitem");
      const open = make("button", "row-main");
      open.type = "button";
      open.title = "Open chat";
      open.append(make("span", "row-title", String(c.title || "Untitled chat")), make("span", "row-date", relTime(c.updated)));
      open.addEventListener("click", () => openChatById(c.id));
      const del = iconButton(ICON_CLOSE, "Delete chat " + String(c.title || ""));
      del.classList.add("row-del");
      del.addEventListener("click", () => deleteChatById(c.id));
      row.append(open, del);
      historyList.appendChild(row);
    }
  }
  async function openHistory() {
    closeMenus();
    setView("history");
    loadHistory();
  }
  async function openChatById(id) {
    historyStatus.textContent = "Opening…";
    try {
      const r = await send({ type: "openChat", id });
      if (!r || r.error) throw new Error(r && r.error ? r.error : "no reply");
      renderTranscript(r.transcript || []);
      setRunning(!!r.running);
      setView("chat");
      inputEl.focus();
    } catch (e) {
      historyStatus.textContent = "Could not open chat: " + errText(e);
    }
  }
  async function deleteChatById(id) {
    if (!window.confirm("Delete this chat? This cannot be undone.")) return;
    try {
      const r = await send({ type: "deleteChat", id });
      if (!r || r.error) throw new Error(r && r.error ? r.error : "no reply");
      loadHistory();
      resyncChat();
    } catch (e) {
      historyStatus.textContent = "Could not delete chat: " + errText(e);
    }
  }
  historyHead.back.addEventListener("click", () => setView("chat"));
  historyBtn.addEventListener("click", () => openHistory());

  // ---------- memory view (PLAN T9) ----------

  let memoryLoadSeq = 0;
  // Fills the read-only Claude Code section. textContent only; failures show the fallback line.
  async function loadProfileInto(seq) {
    let p = null;
    try {
      p = await send({ type: "getProfile" });
    } catch {
      p = null;
    }
    if (seq !== memoryLoadSeq) return;
    const text = p && !p.error ? String(p.text || "") : "";
    ccProfile.textContent = text || "No Claude Code profile found.";
  }
  async function openMemory() {
    closeMenus();
    setView("memory");
    const seq = ++memoryLoadSeq;
    memoryText.value = "";
    ccProfile.textContent = "Loading…";
    loadProfileInto(seq);
    memoryStatus.textContent = "Loading…";
    let r = null;
    try {
      r = await send({ type: "getMemory" });
    } catch (e) {
      r = { error: errText(e) };
    }
    if (seq !== memoryLoadSeq) return;
    if (r && !r.error) {
      memoryText.value = String(r.text || "");
      memoryStatus.textContent = "";
    } else {
      memoryStatus.textContent = (r && r.error) || "Could not load memory.";
    }
  }
  async function saveMemory() {
    memoryStatus.textContent = "Saving…";
    try {
      const r = await send({ type: "setMemory", text: memoryText.value });
      if (!r || r.error) throw new Error(r && r.error ? r.error : "no reply");
      memoryStatus.textContent = "Saved.";
    } catch (e) {
      memoryStatus.textContent = errText(e);
    }
  }
  memoryHead.back.addEventListener("click", () => setView("chat"));
  memorySave.addEventListener("click", () => saveMemory());
  memoryItem.addEventListener("click", () => openMemory());
  layoutItem.addEventListener("click", () => {
    closeMenus();
    copyLayoutReport();
  });

  // ---------- attachments (PLAN T9) ----------

  let pendingAtts = [];
  function setAttachNote(msg) {
    attachNote.textContent = msg || "";
    attachNote.hidden = !msg;
  }
  // Chips for pendingAtts. Thumbnails are object URLs of the picked images.
  function renderChips() {
    attachList.textContent = "";
    for (const att of pendingAtts) {
      const chip = make("div", "chip");
      if (att.url) {
        const img = make("img", "chip-thumb");
        img.alt = "";
        img.src = att.url;
        chip.appendChild(img);
      } else {
        chip.appendChild(icon(ICON_FILE, { width: "1.8" }));
      }
      const x = iconButton(ICON_CLOSE, "Remove " + att.name);
      x.classList.add("chip-x");
      x.addEventListener("click", () => removeAttachment(att));
      chip.append(make("span", "chip-name", att.name), x);
      attachList.appendChild(chip);
    }
    attachList.hidden = pendingAtts.length === 0;
  }
  function removeAttachment(att) {
    const i = pendingAtts.indexOf(att);
    if (i < 0) return;
    pendingAtts.splice(i, 1);
    if (att.url) URL.revokeObjectURL(att.url);
    setAttachNote("");
    renderChips();
  }
  // "image" | "pdf" | "text" | null (unsupported), from the MIME type or, for text, the extension.
  function classify(file) {
    const t = String(file.type || "").toLowerCase();
    if (IMAGE_TYPES.indexOf(t) >= 0) return "image";
    if (t === "application/pdf" || /\.pdf$/i.test(file.name || "")) return "pdf";
    if (TEXT_TYPES.indexOf(t) >= 0 || TEXT_EXT.test(file.name || "")) return "text";
    return null;
  }
  function readFile(file, asText) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      if (asText) reader.readAsText(file);
      else reader.readAsDataURL(file);
    });
  }
  // Reads one file into an attachment record. Images and PDFs become base64 (data: prefix stripped).
  async function readAttachment(file, kind) {
    const name = String(file.name || "file").slice(0, 200);
    const att = { kind, name, mediaType: "", data: null, text: null, url: null };
    if (kind === "text") {
      att.mediaType = file.type || "text/plain";
      att.text = String(await readFile(file, true));
    } else {
      att.mediaType = file.type || (kind === "pdf" ? "application/pdf" : "image/png");
      const dataUrl = String(await readFile(file, false));
      const comma = dataUrl.indexOf(",");
      att.data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
      if (kind === "image") att.url = URL.createObjectURL(file);
    }
    return att;
  }
  async function addFiles(list) {
    setAttachNote("");
    for (const file of Array.from(list || [])) {
      if (pendingAtts.length >= MAX_ATTACHMENTS) {
        setAttachNote("Up to " + MAX_ATTACHMENTS + " attachments per message.");
        break;
      }
      const kind = classify(file);
      if (!kind) {
        setAttachNote((file.name || "File") + ": unsupported file type.");
        continue;
      }
      if (file.size > LIMIT_BYTES[kind]) {
        setAttachNote((file.name || "File") + " is too large (max " + LIMIT_LABEL[kind] + ").");
        continue;
      }
      try {
        const att = await readAttachment(file, kind);
        if (pendingAtts.length >= MAX_ATTACHMENTS) {
          if (att.url) URL.revokeObjectURL(att.url);
          break;
        }
        pendingAtts.push(att);
        renderChips();
      } catch (e) {
        setAttachNote("Could not read " + (file.name || "file") + ": " + errText(e));
      }
    }
    fileInput.value = "";
  }
  // Wire format for background.js: text files carry text, images and PDFs carry base64 data.
  function toPayload(a) {
    const o = { kind: a.kind, name: a.name, mediaType: a.mediaType };
    if (a.kind === "text") o.text = a.text;
    else o.data = a.data;
    return o;
  }
  function clearAttachments() {
    setAttachNote("");
    pendingAtts = [];
    renderChips();
  }

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => addFiles(fileInput.files));
  // Paste: images on the clipboard become attachments. Plain text pastes are left alone.
  inputEl.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
    const files = items.filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });
  // Drag and drop onto the panel. A counter keeps the hint steady while the pointer crosses children.
  let dragDepth = 0;
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf("Files") >= 0;
  wrap.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth++;
    dropHint.hidden = false;
  });
  wrap.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  });
  wrap.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropHint.hidden = true;
  });
  wrap.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    dropHint.hidden = true;
    addFiles(e.dataTransfer.files);
  });

  // ---------- approval bar (one pending approval at a time) ----------

  let pendingApproval = null;
  let approvalTimer = null;
  function askApproval(label) {
    if (WINDOW_MODE) applyCollapsed(false); // visible right away, even if the window resize is slow or fails
    show();
    approvalText.textContent = label;
    approvalEl.hidden = false;
    overlayApproval(true);
    return new Promise((resolve) => {
      pendingApproval = resolve;
      approvalTimer = setTimeout(() => resolveApproval("timeout"), APPROVAL_TIMEOUT_MS);
    });
  }
  // value: true = allow, false = deny, "timeout" = no answer in time.
  function resolveApproval(value) {
    if (!pendingApproval) return;
    const done = pendingApproval;
    pendingApproval = null;
    clearTimeout(approvalTimer);
    approvalTimer = null;
    approvalEl.hidden = true;
    overlayApproval(false);
    done(value);
  }
  // Resolves to "ok", "declined", "timeout" or "busy" (another approval is already pending).
  async function confirmAction(label) {
    if (stopRequested) return "declined";
    if (pendingApproval) return "busy";
    const v = await askApproval(label);
    if (v === true) return "ok";
    return v === "timeout" ? "timeout" : "declined";
  }
  // Approvals for this page's own actions (risky click, Enter) are routed through the background, which shows
  // them in the panel of the tab the user is looking at, whichever tab this is. Never approved on failure.
  async function requestApproval(label, note) {
    if (stopRequested) return "declined";
    try {
      const r = await send({ type: "approvalRequest", label, note: note || "" });
      return typeof r?.result === "string" ? r.result : "unavailable";
    } catch {
      return "unavailable";
    }
  }
  // Error text for a non-"ok" approval result.
  const approvalError = (g) =>
    g === "busy" ? BUSY_MSG : g === "timeout" ? TIMEOUT_MSG : g === "unavailable" ? UNAVAILABLE_MSG : DECLINED_MSG;

  // ---------- chat actions ----------

  async function sendChat() {
    if (running) return;
    const text = inputEl.value.trim();
    const atts = pendingAtts.slice();
    if (!text && !atts.length) return;
    const sendText = text || "See attachment.";
    inputEl.value = "";
    closeSlash();
    stopRequested = false;
    // Set before the send so the echoed user item (which may arrive first) finds its thumbnails.
    echoThumbs = atts.map((a) => a.url);
    try {
      // The background echoes the user item back to us as a "ui" message.
      const r = await send({ type: "chat", text: sendText, attachments: atts.map(toPayload) });
      if (r && r.ok === false) throw new Error(r.error || "send failed");
      // The thumbnails now belong to the bubble; they are revoked when the transcript is rebuilt.
      for (const a of atts) if (a.url) bubbleUrls.push(a.url);
      clearAttachments();
    } catch (e) {
      echoThumbs = null;
      inputEl.value = text;
      addItem({ kind: "error", text: "Could not send: " + errText(e) });
    }
  }
  async function stopAgent() {
    stopRequested = true;
    overlayIdle();
    pointerRemove(); // Stop only: agentStatus idle follows every terminal tool, and the arrow must outlive that
    resolveApproval(false);
    try {
      await send({ type: "stop" });
    } catch (e) {
      addItem({ kind: "error", text: "Could not stop: " + errText(e) });
    }
    // Terminal mode has no chat to clear this flag; the background already declines the stopped run's approvals.
    if (!panelMode) stopRequested = false;
  }
  async function clearChat() {
    closeMenus();
    if (messagesEl.childElementCount > 0 && !window.confirm("Start a new chat? This clears the current conversation.")) return;
    try {
      await send({ type: "clear" });
      renderTranscript([]);
    } catch (e) {
      addItem({ kind: "error", text: "Could not clear: " + errText(e) });
    }
  }

  newBtn.addEventListener("click", () => clearChat());
  menuBtn.addEventListener("click", () => {
    const open = menuEl.hidden;
    closeMenus();
    setMenu(menuEl, menuBtn, open);
  });
  settingsItem.addEventListener("click", () => {
    closeMenus();
    openSettings();
  });
  closeBtn.addEventListener("click", () => {
    if (WINDOW_MODE) send({ type: "closeDock" }).catch(() => {});
    else hide();
  });
  saveBtn.addEventListener("click", () => saveSettings());
  backBtn.addEventListener("click", () => setView("chat"));
  modelBtn.addEventListener("click", () => {
    const open = modelMenu.hidden;
    closeMenus();
    setMenu(modelMenu, modelBtn, open);
  });
  for (const item of modelItems) item.btn.addEventListener("click", () => pickModel(item.id));
  // Clicking anywhere outside the menus and their buttons closes them.
  wrap.addEventListener("click", (e) => {
    const path = e.composedPath();
    if (!path.includes(menuWrap) && !path.includes(modelBtn) && !path.includes(modelMenu)) closeMenus();
  });
  approvalAllow.addEventListener("click", () => resolveApproval(true));
  approvalDeny.addEventListener("click", () => resolveApproval(false));
  sendBtn.addEventListener("click", () => (running ? stopAgent() : sendChat()));
  inputEl.addEventListener("keydown", (e) => {
    if (handleSlashKey(e)) return; // the "/" menu takes ↑ ↓ Enter Tab Esc first
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!running) sendChat();
    }
  });

  // ---------- accessible names and element descriptions ----------

  function accName(el) {
    let n = el.getAttribute("aria-label");
    if (!n) {
      const ids = el.getAttribute("aria-labelledby");
      if (ids) {
        const root = el.getRootNode();
        const lookup = (id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id));
        n = ids
          .split(/\s+/)
          .map((id) => {
            const t = lookup(id);
            return t ? t.textContent : "";
          })
          .join(" ");
      }
    }
    if (!n && el.labels && el.labels.length) {
      n = Array.from(el.labels).map((l) => l.textContent).join(" ");
    }
    if (!n) n = el.getAttribute("placeholder") || el.getAttribute("data-placeholder");
    if (!n && el.tagName.toUpperCase() === "INPUT" && ["submit", "button", "reset"].includes(el.type)) n = el.value;
    if (!n) n = el.getAttribute("alt") || el.getAttribute("title");
    if (!n && !el.isContentEditable && el.tagName.toUpperCase() !== "SELECT") n = el.textContent;
    n = clean(n || "");
    if (!n) {
      // An image link or icon button has no text: use the first descendant img alt/title, then an svg <title>.
      const img = el.querySelector("img[alt]:not([alt='']), img[title]:not([title=''])");
      if (img) n = img.getAttribute("alt") || img.getAttribute("title");
      if (!clean(n || "")) {
        const st = el.querySelector("svg title");
        if (st) n = st.textContent;
      }
    }
    return clip(clean(n || ""), 80);
  }

  function describe(el) {
    const tag = el.tagName.toUpperCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const type = tag === "INPUT" ? (el.type || "").toLowerCase() : "";
    const editable = el.matches('[contenteditable=""], [contenteditable="true"]');
    const label = accName(el);
    let kind;
    if ((tag === "INPUT" && type === "checkbox") || role === "checkbox") kind = "checkbox";
    else if ((tag === "INPUT" && type === "radio") || role === "radio") kind = "radio";
    else if ((tag === "INPUT" && type === "range") || role === "slider") kind = "slider";
    else if (tag === "INPUT" && ["button", "submit", "reset", "image"].includes(type)) kind = "button";
    else if (tag === "BUTTON" || tag === "SUMMARY" || role === "button") kind = "button";
    else if (tag === "A" || role === "link") kind = "link";
    else if (tag === "SELECT") kind = "select";
    else if (tag === "INPUT" && type === "file") kind = "file input";
    else if (tag === "TEXTAREA" || tag === "INPUT" || role === "textbox" || editable) kind = "textbox";
    else if (role === "combobox") kind = "combobox";
    else if (role) kind = role;
    else kind = "clickable";

    const extra = [];
    if (kind === "checkbox" || kind === "radio" || kind === "switch") {
      const checked = tag === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true";
      if (checked) extra.push("(checked)");
    }
    if (kind === "select") {
      const opt = el.selectedOptions && el.selectedOptions[0];
      extra.push('= "' + clip(clean(opt ? opt.text : el.value), 60) + '"');
    }
    if (kind === "textbox") {
      if (editable) {
        extra.push("(contenteditable)");
        const t = clip(clean(el.textContent), 60);
        if (t) extra.push('= "' + t + '"');
      } else if (tag === "TEXTAREA" || tag === "INPUT") {
        if (type === "password") {
          if (el.value) extra.push('= "••••"');
        } else if (el.value) {
          extra.push('= "' + clip(clean(el.value), 60) + '"');
        }
      }
    }
    if (kind === "slider" && tag === "INPUT" && el.value !== "") extra.push("= " + el.value);
    if (kind === "link") {
      const href = el.getAttribute("href");
      if (href && href !== "#" && !href.startsWith("javascript:")) extra.push("→ " + clip(href, 80));
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") extra.push("(disabled)");
    return kind + ' "' + label + '"' + (extra.length ? " " + extra.join(" ") : "");
  }

  function landmarkOf(el, tag) {
    const role = (el.getAttribute("role") || "").toLowerCase();
    const r = LANDMARK_ROLES.has(role) ? role : LANDMARK_TAGS[tag] || "";
    if (!r) return null;
    const name = clip(clean(el.getAttribute("aria-label") || ""), 60);
    if (r === "form" && !name) return null;
    return { role: r, name };
  }

  const prioOf = (el) => {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0) return -r.bottom;
    if (r.top > window.innerHeight) return r.top - window.innerHeight;
    return 0;
  };

  // ---------- read_page ----------

  let refMap = new Map();
  let nextRef = 1;

  function readPage(mode) {
    refMap = new Map();
    nextRef = 1;
    const cands = [];
    const add = (c) => {
      c.idx = cands.length;
      cands.push(c);
    };

    const classify = (el, depth, tag, invisible) => {
      if (invisible) return;
      if (/^H[1-3]$/.test(tag)) {
        const t = clip(clean(el.textContent), 120);
        if (t) add({ line: ind(depth) + "heading " + tag.toLowerCase() + ' "' + t + '"', prio: prioOf(el) });
        return;
      }
      if (el.matches(INTERACTIVE_SEL)) {
        const ref = "ref_" + nextRef++;
        refMap.set(ref, el);
        add({ ref, line: ind(depth) + "[" + ref + "] " + describe(el), prio: prioOf(el) });
        return;
      }
      if (
        mode === "all" &&
        el.matches(TEXT_SEL) &&
        !el.closest(INTERACTIVE_SEL) &&
        !el.querySelector(LEAF_BLOCKERS)
      ) {
        const t = clip(clean(el.textContent), 200);
        if (t) add({ line: ind(depth) + 'text "' + t + '"', prio: prioOf(el) });
      }
    };

    const visit = (el, depth) => {
      if (el === host) return;
      const tag = el.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      const win = el.ownerDocument.defaultView;
      if (!win) return;
      const cs = win.getComputedStyle(el);
      if (el.hidden || el.getAttribute("aria-hidden") === "true" || cs.display === "none") return;
      const r = el.getBoundingClientRect();
      const invisible = cs.visibility === "hidden" || (r.width === 0 && r.height === 0);

      let d = depth;
      const lm = landmarkOf(el, tag);
      if (lm) {
        add({
          line: ind(d) + "[landmark] " + lm.role + (lm.name ? ' "' + lm.name + '"' : ""),
          prio: prioOf(el),
        });
        d++;
      }
      classify(el, d, tag, invisible);

      if (tag === "IFRAME") {
        try {
          const doc = el.contentDocument;
          if (doc && doc.body) visit(doc.body, d);
        } catch (e) {
          // cross-origin frame: skip
        }
      }
      if (el.shadowRoot) {
        for (const c of el.shadowRoot.children) visit(c, d);
      }
      for (const c of el.children) visit(c, d);
    };

    visit(document.body || document.documentElement, 0);

    if (!cands.length) return { text: "No interactive elements found." };

    const head =
      "URL: " + location.href +
      "\nTitle: " + document.title +
      "\nViewport: " + Math.round(window.scrollY) + "/" + document.documentElement.scrollHeight;
    let kept = cands;
    let truncated = false;
    const total = head.length + 2 + cands.reduce((n, c) => n + c.line.length + 1, 0);
    if (total > READ_CAP) {
      truncated = true;
      const order = cands.slice().sort((a, b) => a.prio - b.prio || a.idx - b.idx);
      const chosen = new Set();
      let used = head.length + 2 + 80;
      for (const c of order) {
        const cost = c.line.length + 1;
        if (used + cost > READ_CAP) continue;
        used += cost;
        chosen.add(c);
      }
      kept = cands.filter((c) => chosen.has(c));
      for (const c of cands) if (c.ref && !chosen.has(c)) refMap.delete(c.ref);
    }
    let out = head + "\n\n" + kept.map((c) => c.line).join("\n");
    if (truncated) out += "\n[truncated — scroll and read again]";
    return { text: out };
  }

  // ---------- element refs ----------

  function lookupRef(ref) {
    const id = normRef(ref);
    const el = id ? refMap.get(id) : undefined;
    if (!el || !el.isConnected) return { error: STALE_MSG };
    return { el, id };
  }

  // ---------- click ----------

  const isRisky = (el, name) => RISKY.test(name.toLowerCase()) || (!!el.form && el.type === "submit");

  async function performClick(el, refLabel, name) {
    await scrollIntoMiddle(el);
    if (!el.isConnected) return { error: STALE_MSG };
    await pointerTo(el);
    if (isRisky(el, name)) {
      const g = await requestApproval("Claude wants to click “" + (name || "this element") + "”");
      if (g !== "ok") {
        pointerIdleSoon();
        return { error: approvalError(g) };
      }
      if (!el.isConnected) {
        pointerIdleSoon();
        return { error: STALE_MSG };
      }
    }
    flashOutline(el);
    pointerPress(el);
    // A link that asks for a new tab: el.click() from a content script has no user activation, so the popup is
    // blocked and nothing happens. Open it in this tab instead.
    const a = el.closest && el.closest("a[href]");
    if (a) {
      let newTab = false;
      try {
        const tg = (a.getAttribute("target") || "").trim().toLowerCase();
        newTab = /^https?:$/.test(new URL(a.href).protocol) && tg !== "" && !["_self", "_parent", "_top"].includes(tg);
      } catch {
        // not a valid URL: fall through to the normal click
      }
      if (newTab) {
        const dest = a.href;
        pointerIdleSoon();
        location.assign(dest);
        return {
          text:
            "Opened " +
            (name ? "“" + name + "”" : "the link") +
            " in this tab (the link asked for a new tab, which Safari blocks for extensions).",
        };
      }
    }
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", init));
    el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, pointerType: "mouse", buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
    el.click();
    await sleep(500);
    pointerIdleSoon();
    return { text: "Clicked " + refLabel };
  }

  async function clickTool(input) {
    const r = lookupRef(input.ref);
    if (r.error) return { error: r.error };
    const name = accName(r.el);
    return performClick(r.el, "[" + r.id + "] " + name, name);
  }

  // ---------- keyboard ----------

  function keySpec(name) {
    const n = String(name == null ? "" : name);
    if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, n)) return NAMED_KEYS[n];
    if ([...n].length === 1) {
      const up = n.toUpperCase();
      const code = /[A-Z]/.test(up) ? "Key" + up : /[0-9]/.test(n) ? "Digit" + n : "";
      return { key: n, code, keyCode: up.charCodeAt(0), printable: true };
    }
    return null;
  }

  function keyEvent(type, spec) {
    const ev = new KeyboardEvent(type, {
      key: spec.key,
      code: spec.code,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.defineProperty(ev, "keyCode", { get: () => spec.keyCode });
    Object.defineProperty(ev, "which", { get: () => spec.keyCode });
    return ev;
  }

  const isButtonLike = (el) => el.tagName.toUpperCase() === "BUTTON" || el.getAttribute("role") === "button";

  async function pressKeyOn(target, keyName) {
    const spec = keySpec(keyName);
    if (!spec) return { error: "Unsupported key: " + keyName };
    const isEnter = spec.key === "Enter";
    const tag = target.tagName.toUpperCase();
    const inForm = tag === "INPUT" && !!target.form;
    const editable = target.isContentEditable || tag === "TEXTAREA" || target.getAttribute("role") === "textbox";

    if (isEnter && (inForm || editable)) {
      const name = accName(target);
      const g = await requestApproval(
        "Claude wants to press Enter in “" + (name || "this field") + "”",
        "(this can submit or send it)"
      );
      if (g !== "ok") return { error: approvalError(g) };
    }

    const notPrevented = target.dispatchEvent(keyEvent("keydown", spec));
    if (notPrevented && (spec.printable || isEnter)) target.dispatchEvent(keyEvent("keypress", spec));
    target.dispatchEvent(keyEvent("keyup", spec));

    if (notPrevented && isEnter && inForm && typeof target.form.requestSubmit === "function") {
      target.form.requestSubmit();
      return { text: "Pressed Enter; requested form submit." };
    }
    if (notPrevented && (isEnter || spec.key === " ") && isButtonLike(target)) {
      return performClick(target, "[" + keyName + "] " + accName(target), accName(target));
    }
    // Enter on a link activates it (performClick runs the risk check first).
    if (notPrevented && isEnter && tag === "A" && target.hasAttribute("href")) {
      return performClick(target, "[Enter] " + accName(target), accName(target));
    }
    return {
      text:
        "Dispatched " + keyName + " key events; synthetic keys may not move focus or caret — verify with read_page.",
    };
  }

  // The other copy's UI host (terminal or panel build) on the same page. Its panel is not a place to press keys.
  const OWN_HOST_IDS = ["claude-safari-root", "claude-safari-status", "claude-safari-pointer"].map((i) => i + ID_SUFFIX);
  function isOtherCopyHost(el) {
    return !!el && typeof el.id === "string" && el.id.startsWith("claude-safari-") && !OWN_HOST_IDS.includes(el.id);
  }
  async function pressKeyTool(key) {
    let t = document.activeElement;
    if (t === host || isOtherCopyHost(t)) t = null;
    while (t && t.shadowRoot && t.shadowRoot.activeElement && t.shadowRoot.activeElement !== host) {
      t = t.shadowRoot.activeElement;
    }
    if (!t || t === host) t = document.body || document.documentElement;
    // Keys are never sent into a password / card / one-time-code field.
    if (t !== document.body && t !== document.documentElement && isSensitiveEl(t)) {
      return { error: "Refusing to press keys in a sensitive field. Ask the user to do it." };
    }
    return pressKeyOn(t, key);
  }

  // ---------- type ----------

  // Returns true if the editor accepted the command. Never mutates the DOM directly.
  function insertPiece(el, type, data) {
    const doc = el.ownerDocument;
    try {
      return typeof doc.execCommand === "function" && !!doc.execCommand(type, false, data);
    } catch (e) {
      return false;
    }
  }

  const editableText = (el) => clean(el.innerText || el.textContent || "");

  // Returns an { error } object on failure, or null on success.
  function typeIntoEditable(el, text, clear, name) {
    const doc = el.ownerDocument;
    const sel = (doc.defaultView || window).getSelection();
    const range = doc.createRange();
    if (clear) {
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        doc.execCommand("delete", false, null);
      } catch (e) {
        // fall through to the check below
      }
      if (editableText(el)) return { error: "Could not clear the field; ask the user to clear it." };
    }
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    const before = editableText(el);
    text.split(/\r?\n/).forEach((line, i) => {
      if (i > 0) insertPiece(el, "insertParagraph", null);
      if (line) insertPiece(el, "insertText", line);
    });
    const typed = clean(text);
    if (typed) {
      const after = editableText(el);
      if (!(after.length > before.length || after.includes(typed))) {
        return { error: "Typing had no effect on " + (name || "the field") + "; the editor may need a click first." };
      }
    }
    return null;
  }

  async function typeTool(input) {
    const r = lookupRef(input.ref);
    if (r.error) return { error: r.error };
    const el = r.el;
    const tag = el.tagName.toUpperCase();
    const name = accName(el);
    const text = input.text == null ? "" : String(input.text);

    if (isSensitiveEl(el)) {
      return { error: SENSITIVE_MSG };
    }
    const isField = tag === "TEXTAREA" || (tag === "INPUT" && !NON_TEXT_INPUTS.has((el.type || "").toLowerCase()));
    const isEditable = !isField && el.isContentEditable;
    if (!isField && !isEditable) {
      return { error: "That element is not a text field. Use read_page to find a text box." };
    }

    await scrollIntoMiddle(el);
    el.focus();
    flashOutline(el);
    await pointerTo(el, true);
    await sleep(100);
    if (!el.isConnected) {
      pointerIdleSoon();
      return { error: STALE_MSG };
    }

    if (isField) {
      const W = el.ownerDocument.defaultView || window;
      const proto = tag === "TEXTAREA" ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, input.clear ? text : el.value + text);
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      const typed = clean(text);
      if (typed && !clean(el.value).includes(typed)) {
        pointerIdleSoon();
        return { error: "Typing had no effect on " + (name || "the field") + "; the editor may need a click first." };
      }
    } else {
      const failure = typeIntoEditable(el, text, !!input.clear, name);
      if (failure) {
        pointerIdleSoon();
        return failure;
      }
    }

    let note = "";
    if (input.submit) {
      const k = await pressKeyOn(el, "Enter");
      if (k.error) {
        pointerIdleSoon();
        return { error: "Typed the text, but pressing Enter failed: " + k.error };
      }
      note = " and pressed Enter";
    }
    pointerIdleSoon();
    return { text: "Typed " + text.length + " chars into [" + r.id + "] " + name + note };
  }

  // ---------- scroll ----------

  const position = () =>
    "scrollY=" + Math.round(window.scrollY) + " scrollHeight=" + document.documentElement.scrollHeight;

  function scrollBestInnerAt(delta) {
    const els = document.elementsFromPoint(window.innerWidth / 2, window.innerHeight / 2) || [];
    let best = null;
    for (const el of els) {
      if (el === host || el === document.documentElement || el === document.body) continue;
      const cs = window.getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 10) continue;
      if (!best || el.clientHeight > best.clientHeight) best = el;
    }
    if (best) best.scrollBy({ top: delta });
  }

  async function scrollTool(input) {
    if (input.ref != null && input.ref !== "") {
      const r = lookupRef(input.ref);
      if (r.error) return { error: r.error };
      r.el.scrollIntoView({ block: "center" });
      await sleep(250);
      await pointerTo(r.el);
      pointerIdleSoon();
      return { text: "Scrolled [" + r.id + "] into view. " + position() };
    }
    const dir = input.direction;
    const step = Math.round(window.innerHeight * 0.8);
    if (dir === "top") {
      window.scrollTo({ top: 0 });
    } else if (dir === "bottom") {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    } else if (dir === "up" || dir === "down") {
      const delta = dir === "down" ? step : -step;
      const before = window.scrollY;
      window.scrollBy({ top: delta });
      if (window.scrollY === before) scrollBestInnerAt(delta);
    } else {
      return { error: "Give a direction (up, down, top, bottom) or a ref." };
    }
    await sleep(300);
    return { text: "Scrolled " + dir + ". " + position() };
  }

  // ---------- get_page_text ----------

  function getPageText() {
    const main = document.querySelector("main, [role=main], article");
    const mainText = main ? main.innerText || "" : "";
    const src = mainText.length > 500 ? main : document.body || document.documentElement;
    let text = (src.innerText || src.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return { text: "No visible text found." };
    if (text.length > TEXT_CAP) text = text.slice(0, TEXT_CAP) + "\n[truncated]";
    return { text };
  }

  // ---------- exec dispatch ----------

  async function execTool(tool, input) {
    switch (tool) {
      case "read_page":
        return readPage(input.mode === "all" ? "all" : "interactive");
      case "get_page_text":
        return getPageText();
      case "click":
        return clickTool(input);
      case "type":
        return typeTool(input);
      case "press_key":
        return pressKeyTool(input.key);
      case "scroll":
        return scrollTool(input);
      default:
        return { error: "Unknown page tool: " + tool };
    }
  }

  // Exactly one sendResponse per exec message, even if the tool throws.
  function runExec(msg, sendResponse) {
    let replied = false;
    const reply = (r) => {
      if (replied) return;
      replied = true;
      try {
        sendResponse(r && typeof r === "object" ? r : { error: "Tool returned no result" });
      } catch (e) {
        // the channel was closed; nothing else to do
      }
    };
    let work;
    try {
      work = Promise.resolve(execTool(msg.tool, msg.input || {}));
    } catch (e) {
      work = Promise.reject(e);
    }
    work.then(reply, (e) => reply({ error: errText(e) }));
  }

  // Messages that only make sense on a web page: the docked window has no page, so it ignores them.
  const PAGE_ONLY = new Set(["toggle", "agentStatus", "tabMark", "refLabel", "exec"]);
  // Background messages. In a page or the in-page panel they arrive as runtime messages (sendResponse replies);
  // in window mode they arrive on the port (the reply is a post back on the port).
  function handleBackground(msg, sendResponse) {
    if (!msg || typeof msg !== "object") return;
    if (WINDOW_MODE && PAGE_ONLY.has(msg.type)) return;
    if (msg.type === "toggle") {
      if (panelMode) toggle(); // terminal mode never shows the panel
      return;
    }
    // Terminal mode (PLAN T13b): the tab is shared (true) or not (false). Only the top frame keeps a port.
    if (msg.type === "shareState") {
      if (window.top === window) setShared(!!msg.shared);
      pointerBlocked = !msg.shared; // a tool still in flight must not draw on a tab that was just unshared
      if (!msg.shared) pointerRemove();
      return;
    }
    if (msg.type === "dockState") {
      if (WINDOW_MODE) {
        applyCollapsed(msg.collapsed);
        revealWindowHost();
      }
      return;
    }
    if (msg.type === "ui") {
      handleUI(msg.item);
      return;
    }
    // The background switched or cleared the current chat. Its payload has only the id, so re-read.
    if (msg.type === "chatChanged") {
      resyncChat();
      return;
    }
    if (msg.type === "skillsChanged") {
      if (!skillPending) applySkills(msg.skills); // a write of ours is in flight: its reply decides
      return;
    }
    // Visible actions (PLAN T11b). Top frame only: one glow and one pill per tab.
    if (msg.type === "agentStatus") {
      if (window.top !== window) return;
      if (msg.state === "working") overlayWorking(clean(msg.label) || "working", msg.approval);
      else overlayIdle();
      return;
    }
    if (msg.type === "workStatus") {
      if (window.top !== window) return;
      renderWorkLine(msg);
      return;
    }
    if (msg.type === "cancelApproval") {
      if (window.top !== window) return;
      resolveApproval(false);
      return;
    }
    if (msg.type === "refLabel") {
      refLabelReply(msg, sendResponse);
      return;
    }
    // Claude's tab group (PLAN T11a). Only the top frame answers, so one panel shows the approval.
    if (msg.type === "tabMark" || msg.type === "tabGroup" || msg.type === "confirm") {
      if (window.top !== window) return;
    }
    if (msg.type === "tabMark") {
      setTabMark(msg.on);
      return;
    }
    if (msg.type === "tabGroup") {
      renderTabGroup(msg.tabs);
      return;
    }
    if (msg.type === "confirm") {
      confirmAction(String(msg.label || "")).then(
        (result) => sendResponse({ result }),
        () => sendResponse({ result: "declined" })
      );
      return true; // async reply
    }
    if (msg.type === "exec") {
      runExec(msg, sendResponse);
      return true; // async reply
    }
  }
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => handleBackground(msg, sendResponse));

  // ---------- visible actions (PLAN T11b) ----------
  // Its own shadow host, separate from the panel. Only the Stop button takes pointer events; the glow
  // is an inset box-shadow over the viewport and never changes page layout. Built with
  // createElement/textContent only.
  const STATUS_HOST_ID = "claude-safari-status" + ID_SUFFIX;
  const HIGHLIGHT_MS = 600;
  const STATUS_CSS = `
[hidden]{display:none !important}
.glow{position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity .3s ease;
  box-shadow:inset 0 0 0 1px rgba(217,119,87,.55),inset 0 0 40px 8px rgba(217,119,87,.45)}
.glow.on{opacity:1}
.glow.pulse{animation:cs-glow 2.6s ease-in-out infinite}
@keyframes cs-glow{0%,100%{opacity:.7}50%{opacity:1}}
.pill-wrap{position:fixed;left:0;right:var(--pw,0px);bottom:18px;display:flex;justify-content:center;pointer-events:none;padding:0 16px}
.pill{display:flex;align-items:center;gap:10px;max-width:100%;box-sizing:border-box;padding:7px 7px 7px 14px;border-radius:999px;background:#211f1c;color:#f6efe6;border:1px solid rgba(217,119,87,.55);box-shadow:0 8px 28px rgba(0,0,0,.35);font:500 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.pill-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.allow,.deny{pointer-events:auto;flex:none;border:0;border-radius:999px;padding:5px 12px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer}
.allow{background:#2e7d32;color:#fff}
.deny{background:#4a463f;color:#f6efe6}
.stop{pointer-events:auto;flex:none;border:0;border-radius:999px;padding:5px 12px;background:#D97757;color:#fff;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer}
.hl{position:fixed;box-sizing:border-box;border:2px solid #D97757;border-radius:6px;pointer-events:none}
@media (prefers-reduced-motion: reduce){.glow{transition:none}.glow.pulse{animation:none}}
`;
  let statusHost = null;
  let statusShadow = null;
  let glowEl = null;
  let pillWrap = null;
  let pillText = null;
  let allowBtn = null;
  let denyBtn = null;
  let approvalId = null; // terminal mode: the approval this pill asks about (Allow / Deny shown); null otherwise
  let termApprovalText = "";
  let approvalPing = null; // keeps the background awake while an approval waits
  let overlayLabel = null; // the working label; null when idle
  let overlayStaleTimer = null;
  const OVERLAY_STALE_MS = 15000; // no agentStatus for this long: assume the run is over and clear the glow
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function ensureStatus() {
    if (statusHost) {
      if (!statusHost.isConnected) (document.documentElement || document.body).appendChild(statusHost);
      popoverOpen(statusHost);
      return;
    }
    statusHost = document.createElement("div");
    statusHost.id = STATUS_HOST_ID;
    if (POPOVER_OK) statusHost.setAttribute("popover", "manual");
    statusHost.style.cssText = POPOVER_CSS + "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;";
    // Closed: the page cannot reach into the shadow tree to change the question or click Allow.
    statusShadow = statusHost.attachShadow({ mode: "closed" });
    const style = make("style");
    style.textContent = STATUS_CSS;
    glowEl = make("div", "glow");
    pillWrap = make("div", "pill-wrap");
    pillWrap.hidden = true;
    const pill = make("div", "pill");
    pillText = make("span", "pill-text");
    const stop = make("button", "stop", "Stop");
    stop.type = "button";
    stop.setAttribute("aria-label", "Stop Claude");
    stop.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      overlayIdle();
      stopAgent();
    });
    allowBtn = make("button", "allow", "Allow");
    allowBtn.type = "button";
    allowBtn.hidden = true;
    denyBtn = make("button", "deny", "Deny");
    denyBtn.type = "button";
    denyBtn.hidden = true;
    allowBtn.addEventListener("click", (e) => answerApproval(e, true));
    denyBtn.addEventListener("click", (e) => answerApproval(e, false));
    pill.append(pillText, allowBtn, denyBtn, stop);
    pillWrap.appendChild(pill);
    statusShadow.append(style, glowEl, pillWrap);
    syncOverlayLayout();
    (document.documentElement || document.body).appendChild(statusHost);
    popoverOpen(statusHost);
  }
  // The pill stays clear of the side panel: it spans only the page area left of an open panel.
  function syncOverlayLayout() {
    if (statusHost) statusHost.style.setProperty("--pw", host.style.display === "block" ? PUSH_WIDTH : "0px");
  }
  function setPillText(label) {
    pillText.textContent = approvalId ? "✦ " + termApprovalText + " Allow?" : "✦ Claude is working — " + label;
  }
  // Terminal mode: the human answers an approval here when the MCP client cannot ask. Only a real click counts.
  function answerApproval(e, approve) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.isTrusted || !approvalId) return;
    const id = approvalId;
    showApproval(null);
    send({ type: "approvalDecision", id, approve: approve === true }).catch(() => {});
  }
  function showApproval(ap) {
    approvalId = ap ? ap.id : null;
    termApprovalText = ap ? clean(ap.label).slice(0, 200) || "Claude wants to act on this page." : "";
    if (allowBtn) allowBtn.hidden = denyBtn.hidden = !ap;
    if (ap && !approvalPing) {
      approvalPing = setInterval(() => {
        try {
          if (keepPort) keepPort.postMessage({ type: "ping" });
        } catch (e) {
          // the port is being reopened
        }
      }, 20000);
    }
    if (!ap && approvalPing) {
      clearInterval(approvalPing);
      approvalPing = null;
    }
    if (pillText && overlayLabel != null) setPillText(overlayLabel);
  }
  function overlayWorking(label, approval) {
    ensureStatus();
    overlayLabel = label;
    showApproval(approval && typeof approval.id === "string" ? approval : null);
    setPillText(label);
    pillWrap.hidden = false;
    glowEl.className = reduceMotion() ? "glow on" : "glow on pulse";
    syncOverlayLayout();
    clearTimeout(overlayStaleTimer);
    overlayStaleTimer = setTimeout(overlayIdle, OVERLAY_STALE_MS);
  }
  function removeStatusHost() {
    if (statusHost) statusHost.remove();
    statusHost = statusShadow = glowEl = pillWrap = pillText = allowBtn = denyBtn = null;
  }
  function overlayIdle() {
    showApproval(null);
    overlayLabel = null;
    clearTimeout(overlayStaleTimer);
    overlayStaleTimer = null;
    removeStatusHost(); // recreated by ensureStatus on the next working state
    if (pointerHost && pointerIdlePending) {
      // the 4 s arrow fade was held while working; it starts now (or on return to visible)
      pointerIdlePending = false;
      pointerIdleSoon();
    }
  }
  // While an approval waits, the pill says so; the working label comes back afterwards.
  function overlayApproval(waiting) {
    if (overlayLabel == null || !pillText) return;
    setPillText(waiting ? "Waiting for your approval" : overlayLabel);
  }
  // 2px orange outline over an element for HIGHLIGHT_MS. It is an overlay box; the element is not touched.
  function flashOutline(el) {
    if (!el || !el.isConnected || el.ownerDocument !== document) return;
    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } catch {
      el.scrollIntoView({ block: "center" });
    }
    // Read the rect on the next frame, after the scroll has landed.
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      ensureStatus();
      const box = make("div", "hl");
      box.style.setProperty("left", r.left + "px");
      box.style.setProperty("top", r.top + "px");
      box.style.setProperty("width", r.width + "px");
      box.style.setProperty("height", r.height + "px");
      statusShadow.appendChild(box);
      setTimeout(() => {
        box.remove();
        // Nothing else to show: take the host out again.
        if (overlayLabel == null && statusShadow && !statusShadow.querySelector(".hl")) removeStatusHost();
      }, HIGHLIGHT_MS);
    });
  }
  // Bring the element to the middle of the viewport before acting on it.
  async function scrollIntoMiddle(el) {
    el.scrollIntoView({ block: "center", behavior: reduceMotion() ? "instant" : "auto" });
    await sleep(reduceMotion() ? 50 : 200);
  }
  // ---------- visible pointer (PLAN T14) ----------
  // A drawn arrow in its own closed-shadow host, one per document. It moves only for exec actions. No tool awaits
  // an animation; pointer code dispatches no mouse or pointer events and never touches the real cursor.
  const POINTER_HOST_ID = "claude-safari-pointer" + ID_SUFFIX;
  const POINTER_SVG_NS = "http://www.w3.org/2000/svg";
  const POINTER_TIP = { x: 2 * (28 / 30), y: 2 * (31 / 32) }; // the arrow tip inside its 28x31 px box
  const POINTER_HOST_CSS = [
    ["all", "initial"], ["position", "fixed"], ["top", "0"], ["left", "0"], ["width", "100%"], ["height", "100%"],
    ["z-index", "2147483646"], ["pointer-events", "none"], ["display", "block"], ["visibility", "visible"], ["overflow", "hidden"],
  ];
  const POINTER_CSS = `
.w{position:fixed;left:0;top:0;width:28px;height:31px;pointer-events:none;will-change:transform;transform:translate(-100px,-100px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.w svg{display:block;width:28px;height:31px}
.r{position:fixed;left:0;top:0;width:28px;height:28px;box-sizing:border-box;border:2px solid #D97757;border-radius:50%;pointer-events:none}
`;
  let pointerBlocked = false;
  let pointerHost = null;
  let pointerShadow = null;
  let pointerWrap = null;
  let pointerLast = null; // {x, y}: where the tip was last put
  let pointerGlide = null;
  let pointerFade = null;
  let pointerIdleTimer = null;
  let pointerGoneTimer = null;
  let pointerIdlePending = false; // an idle fade was due while the document was hidden; starts on return to visible

  function ensurePointer() {
    if (pointerHost) {
      if (!pointerHost.isConnected) (document.documentElement || document.body).appendChild(pointerHost);
      popoverOpen(pointerHost);
      return;
    }
    pointerHost = document.createElement("div");
    pointerHost.id = POINTER_HOST_ID;
    pointerHost.setAttribute("aria-hidden", "true");
    if (POPOVER_OK) pointerHost.setAttribute("popover", "manual");
    // all:initial first, then the layout values, each !important, so page CSS cannot hide or move the host.
    for (const [k, v] of POINTER_HOST_CSS) pointerHost.style.setProperty(k, v, "important");
    pointerShadow = pointerHost.attachShadow({ mode: "closed" });
    const style = make("style");
    style.textContent = POINTER_CSS;
    pointerWrap = make("div", "w");
    const svg = document.createElementNS(POINTER_SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 30 32");
    svg.setAttribute("preserveAspectRatio", "none");
    const path = document.createElementNS(POINTER_SVG_NS, "path");
    path.setAttribute("d", "M2 2 L2 26 L8.5 20 L13 30 L17 28 L12.5 18.5 L21 18.5 Z");
    path.setAttribute("fill", "#D97757");
    path.setAttribute("stroke", "#ffffff");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    pointerWrap.appendChild(svg);
    pointerShadow.append(style, pointerWrap);
    (document.documentElement || document.body).appendChild(pointerHost);
    popoverOpen(pointerHost);
  }

  // Moves the arrow tip onto el (its centre; the left edge when atField). Glides when visible and not reduced
  // motion, otherwise jumps. A hidden document (Safari behind another app) is placed with a plain transform: no
  // fade, no glide, no wait. Never throws and never waits longer than 150 ms.
  async function pointerTo(el, atField) {
    try {
      if (pointerBlocked || !el || !el.isConnected || el.ownerDocument !== document) return;
      try {
        el.scrollIntoView({ block: "center", behavior: "instant" });
      } catch {
        el.scrollIntoView({ block: "center" });
      }
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      if (r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight) return;
      const cx = atField ? r.left + Math.min(16, r.width / 2) : r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const to = {
        x: Math.min(Math.max(cx, 0), window.innerWidth - 1),
        y: Math.min(Math.max(cy, 0), window.innerHeight - 1),
      };
      const fresh = !pointerHost;
      ensurePointer();
      clearTimeout(pointerIdleTimer);
      clearTimeout(pointerGoneTimer);
      pointerIdleTimer = pointerGoneTimer = null;
      pointerIdlePending = false;
      if (pointerFade) pointerFade.cancel();
      if (pointerGlide) pointerGlide.cancel();
      pointerFade = pointerGlide = null;
      const from = pointerLast || to;
      pointerLast = to;
      const at = (p) => "translate(" + (p.x - POINTER_TIP.x) + "px, " + (p.y - POINTER_TIP.y) + "px)";
      pointerWrap.style.transform = at(to);
      if (document.hidden) return; // placed; no animation and no wait while hidden
      if (fresh) {
        pointerFade = pointerWrap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
        pointerFade.finished.catch(() => {});
      } else if (!reduceMotion()) {
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const duration = Math.min(280, Math.max(180, 180 + dist * 0.25));
        pointerGlide = pointerWrap.animate([{ transform: at(from) }, { transform: at(to) }], {
          duration,
          easing: "cubic-bezier(0.22,1,0.36,1)",
        });
        pointerGlide.finished.catch(() => {});
        await sleep(150); // the only wait; the glide itself is never awaited
      }
    } catch {
      // a pointer failure never changes a tool result
    }
  }

  // Press pulse: one orange ring at the element centre, 400 ms, then removed. Skipped under reduced motion.
  function pointerPress(el) {
    try {
      if (!pointerHost || !el || !el.isConnected || el.ownerDocument !== document) return;
      if (reduceMotion() || document.hidden) return;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const ring = make("div", "r");
      ring.style.setProperty("left", r.left + r.width / 2 - 14 + "px");
      ring.style.setProperty("top", r.top + r.height / 2 - 14 + "px");
      pointerShadow.appendChild(ring);
      ring.animate([{ transform: "scale(0)", opacity: 1 }, { transform: "scale(1)", opacity: 0 }], {
        duration: 400,
        easing: "ease-out",
        fill: "forwards", // no one-frame flash of the full ring before the timer removes it
      }).finished.catch(() => {});
      setTimeout(() => ring.remove(), 400);
    } catch {
      // ignored
    }
  }

  // After an action completes: fade the arrow out after 4 s of rest, then detach the host. While the document is
  // hidden or the overlay is working (a run is in progress) the timer is not started; the fade is marked pending and
  // starts when the document is visible and the run is idle (visibilitychange / overlayIdle).
  function pointerIdleSoon() {
    try {
      if (!pointerHost) return;
      clearTimeout(pointerIdleTimer);
      pointerIdleTimer = null;
      if (document.hidden || overlayLabel != null) {
        pointerIdlePending = true;
        return;
      }
      pointerIdlePending = false;
      pointerIdleTimer = setTimeout(() => {
        pointerIdleTimer = null;
        try {
          if (!pointerWrap) return;
          if (document.hidden || overlayLabel != null) {
            pointerIdlePending = true;
            return;
          }
          pointerFade = pointerWrap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" });
          pointerFade.finished.catch(() => {});
          clearTimeout(pointerGoneTimer);
          pointerGoneTimer = setTimeout(pointerRemove, 320);
        } catch {
          // ignored
        }
      }, 4000);
    } catch {
      // ignored
    }
  }

  // Takes the arrow off the page at once. Called on shareState false, Stop, and after fade-out.
  function pointerRemove() {
    try {
      clearTimeout(pointerIdleTimer);
      clearTimeout(pointerGoneTimer);
      pointerIdleTimer = pointerGoneTimer = null;
      pointerIdlePending = false;
      if (pointerGlide) pointerGlide.cancel();
      if (pointerFade) pointerFade.cancel();
      pointerGlide = pointerFade = null;
      if (pointerHost) pointerHost.remove();
    } catch {
      // ignored
    }
    pointerHost = pointerShadow = pointerWrap = pointerLast = null;
  }
  // Becoming visible again with an idle fade pending starts the 4 s idle timer then. Nothing else.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && overlayLabel == null && pointerIdlePending) {
      pointerIdlePending = false;
      pointerIdleSoon();
    }
  });

  // Passwords, card numbers and one-time codes: never typed into, and never named in a label.
  function isSensitiveEl(el) {
    const tag = el.tagName.toUpperCase();
    return (
      (tag === "INPUT" && (el.type || "").toLowerCase() === "password") ||
      isSensitiveText(accName(el)) ||
      isSensitiveText(el.getAttribute("name")) ||
      isSensitiveText(el.id) ||
      SENSITIVE_AUTOCOMPLETE.test((el.getAttribute("autocomplete") || "").toLowerCase())
    );
  }
  // Background asks for an element's name before it clicks or types (labels). Only the frame holding
  // the ref answers; sensitive fields answer with no name.
  function refLabelReply(msg, sendResponse) {
    const id = normRef(msg.ref);
    const el = id ? refMap.get(id) : undefined;
    if (!el || !el.isConnected) return;
    if (msg.action === "type" && isSensitiveEl(el)) {
      sendResponse({ text: "", sensitive: true });
      return;
    }
    sendResponse({ text: accName(el) });
  }

  // ---------- Claude Code skills (PLAN T11c) ----------
  // chatSkills: [{id,name}] of the current chat (from getState, skillsChanged, or a toggle reply).
  let chatSkills = [];
  let skillCatalog = null; // [{id,name,description}] from listSkills, or null
  let skillCatalogAt = 0;
  const SKILL_CATALOG_MS = 60 * 1000;
  const SLASH_MAX_ROWS = 8;
  const skillBoxes = new Map(); // id -> checkbox in the Skills view
  let skillsLoadSeq = 0;

  // Returns { skills, error? }. Reuses the catalog for 60 s; a failure keeps the old list.
  let skillTryAt = 0; // last attempt; a failed lookup is not retried for 10 s (unless forced)
  let skillTryError = "";
  const SKILL_RETRY_MS = 10 * 1000;
  async function loadCatalog(force) {
    if (!force && skillCatalog && Date.now() - skillCatalogAt < SKILL_CATALOG_MS) return { skills: skillCatalog };
    if (!force && skillTryError && Date.now() - skillTryAt < SKILL_RETRY_MS) return { skills: skillCatalog || [], error: skillTryError };
    skillTryAt = Date.now();
    let r = null;
    try {
      r = await send({ type: "listSkills" });
    } catch (e) {
      r = { error: errText(e) };
    }
    if (!r) r = { error: "no reply" };
    skillTryError = r.error || "";
    if (!r.error) {
      skillCatalog = Array.isArray(r.skills) ? r.skills : [];
      skillCatalogAt = Date.now();
    }
    return { skills: skillCatalog || [], error: r.error };
  }

  function applySkills(list) {
    chatSkills = (Array.isArray(list) ? list : [])
      .filter((s) => s && typeof s.id === "string")
      .map((s) => ({ id: s.id, name: clean(s.name) || s.id }));
    renderSkillChips();
    const ids = new Set(chatSkills.map((s) => s.id));
    for (const [id, box] of skillBoxes) box.checked = ids.has(id);
  }

  function renderSkillChips() {
    skillChips.textContent = "";
    skillChips.hidden = chatSkills.length === 0;
    for (const s of chatSkills) {
      const chip = make("div", "chip skill-chip");
      chip.title = s.id;
      chip.append(make("span", "skill-chip-name", "⚡ " + s.name));
      const x = iconButton(ICON_CLOSE, "Remove skill " + s.name);
      x.classList.add("chip-x");
      x.addEventListener("click", () => setSkills(chatSkills.filter((o) => o.id !== s.id).map((o) => o.id)));
      chip.append(x);
      skillChips.appendChild(chip);
    }
  }

  // Saves the chat's skill ids. The new list shows at once (optimistic); the background applies the
  // writes in order, and only the reply to the last pending write is applied here.
  let skillPending = 0;
  let skillBase = [];
  function syncSkillBoxes() {
    const have = new Set(chatSkills.map((s) => s.id));
    for (const [id, box] of skillBoxes) box.checked = have.has(id);
  }
  async function setSkills(ids) {
    if (skillPending === 0) skillBase = chatSkills;
    const known = (id) => (chatSkills.find((o) => o.id === id) || (skillCatalog || []).find((o) => o.id === id) || {}).name;
    chatSkills = ids.map((id) => ({ id, name: clean(known(id)) || id }));
    renderSkillChips();
    syncSkillBoxes();
    skillPending++;
    try {
      const r = await send({ type: "setChatSkills", ids });
      if (!r || r.error) throw new Error(r && r.error ? r.error : "no reply");
      skillPending--;
      if (skillPending === 0) applySkills(r.skills);
      skillsStatus.textContent = "";
    } catch (e) {
      skillPending--;
      skillsStatus.textContent = "Could not change skills: " + errText(e);
      if (skillPending === 0) {
        applySkills(skillBase); // put the chips and checkboxes back
        resyncChat();
      }
    }
  }

  async function openSkills() {
    closeMenus();
    setView("skills");
    const seq = ++skillsLoadSeq;
    skillsList.textContent = "";
    skillBoxes.clear();
    skillsStatus.textContent = "Loading…";
    const r = await loadCatalog(true);
    if (seq !== skillsLoadSeq) return;
    const list = r.skills || [];
    if (r.error) skillsStatus.textContent = r.error;
    else if (!list.length) skillsStatus.textContent = "No skills yet. Add a folder with a SKILL.md file to ~/.claude/skills.";
    else skillsStatus.textContent = "";
    const active = new Set(chatSkills.map((s) => s.id));
    for (const s of list) {
      const row = make("div", "row");
      row.setAttribute("role", "listitem");
      const label = make("label", "skill-row");
      const box = make("input");
      box.type = "checkbox";
      box.checked = active.has(s.id);
      box.setAttribute("aria-label", "Use skill " + (clean(s.name) || s.id));
      skillBoxes.set(s.id, box);
      box.addEventListener("change", () => {
        const others = chatSkills.map((o) => o.id).filter((id) => id !== s.id);
        setSkills(box.checked ? [...others, s.id] : others);
      });
      const text = make("span", "skill-text");
      text.append(make("span", "skill-name", clean(s.name) || s.id), make("span", "skill-desc", clean(s.description)));
      label.append(box, text);
      row.append(label);
      skillsList.appendChild(row);
    }
  }

  // The "/token" at the start of the input, if the caret is still inside it.
  function slashToken() {
    const v = inputEl.value;
    if (!v.startsWith("/")) return null;
    const ws = v.search(/\s/);
    const end = ws < 0 ? v.length : ws;
    if (inputEl.selectionStart < 1 || inputEl.selectionStart > end) return null;
    return { query: v.slice(1, end), end };
  }

  let slashOpen = false;
  let slashRows = []; // [{ skill, btn }]
  let slashIndex = 0;
  let slashSeq = 0;
  let slashNotice = false; // the menu shows one muted status row instead of skills

  function closeSlash() {
    slashSeq++; // a pending lookup must not reopen the menu
    slashOpen = false;
    slashNotice = false;
    slashRows = [];
    slashMenu.textContent = "";
    slashMenu.hidden = true;
  }

  function renderSlashNotice(text) {
    slashMenu.textContent = "";
    slashRows = [];
    slashNotice = true;
    slashOpen = true;
    slashMenu.appendChild(make("div", "slash-note", text));
    slashMenu.hidden = false;
  }

  function renderSlash(hits) {
    slashNotice = false;
    slashMenu.textContent = "";
    slashRows = hits.map((s, i) => {
      const btn = make("button");
      btn.type = "button";
      btn.setAttribute("role", "option");
      btn.append(make("span", "skill-name", clean(s.name) || s.id), make("span", "skill-desc", clean(s.description)));
      btn.addEventListener("click", () => pickSkill(s));
      btn.addEventListener("mouseenter", () => setSlashIndex(i));
      slashMenu.appendChild(btn);
      return { skill: s, btn };
    });
    slashOpen = true;
    slashMenu.hidden = false;
    setSlashIndex(0);
  }

  function setSlashIndex(i) {
    slashIndex = i;
    slashRows.forEach((r, j) => {
      r.btn.classList.toggle("active", j === i);
      r.btn.setAttribute("aria-selected", String(j === i));
    });
  }

  function moveSlash(d) {
    if (!slashRows.length) return;
    setSlashIndex((slashIndex + d + slashRows.length) % slashRows.length);
    slashRows[slashIndex].btn.scrollIntoView({ block: "nearest" });
  }

  // Filters the catalog by the text after "/" (id, name or description). Max 8 rows.
  async function slashUpdate() {
    const tok = slashToken();
    if (!tok) return closeSlash();
    const seq = ++slashSeq;
    if (!skillCatalog) renderSlashNotice("Loading skills…");
    const r = await loadCatalog(false);
    if (seq !== slashSeq) return;
    const now = slashToken();
    if (!now) return closeSlash();
    if (r.error && !r.skills.length) return renderSlashNotice("Skills unavailable — is the bridge running?");
    const q = now.query.toLowerCase();
    const hits = r.skills
      .filter((s) => !q || [s.id, s.name, s.description].some((x) => String(x || "").toLowerCase().includes(q)))
      .slice(0, SLASH_MAX_ROWS);
    if (!hits.length) return closeSlash();
    renderSlash(hits);
  }

  // Selecting removes the "/token" from the input and adds the skill to the chat.
  function pickSkill(s) {
    const tok = slashToken();
    if (tok) {
      inputEl.value = inputEl.value.slice(tok.end).replace(/^\s/, "");
      inputEl.setSelectionRange(0, 0);
    }
    closeSlash();
    const ids = chatSkills.map((o) => o.id);
    if (!ids.includes(s.id)) setSkills([...ids, s.id]);
    inputEl.focus();
  }

  // Returns true when the key was used by the "/" menu.
  function handleSlashKey(e) {
    if (!slashOpen) return false;
    if (slashNotice) {
      // Status row only: Enter must not send "/query" while it is showing; Esc closes it.
      if (e.key === "Escape") closeSlash();
      else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { /* swallowed */ }
      else return false;
      e.preventDefault();
      return true;
    }
    if (!slashRows.length) return false;
    if (e.key === "ArrowDown") moveSlash(1);
    else if (e.key === "ArrowUp") moveSlash(-1);
    else if ((e.key === "Enter" && !e.shiftKey && !e.isComposing) || e.key === "Tab") pickSkill(slashRows[slashIndex].skill);
    else if (e.key === "Escape") closeSlash();
    else return false;
    e.preventDefault();
    return true;
  }

  inputEl.addEventListener("input", () => {
    slashUpdate();
  });
  skillsItem.addEventListener("click", () => openSkills());
  skillsHead.back.addEventListener("click", () => setView("chat"));

  // ---------- mount and restore state ----------

  // Renders the chat from a getState reply. Opens the panel only on first load, if a run is active.
  function applyState(st, openIfRunning) {
    if (!st) return;
    setRunning(!!st.running); // before the transcript, so in-flight tool lines keep their mark
    renderTranscript(st.transcript || []);
    renderTabGroup(st.tabs);
    if (Array.isArray(st.skills) && !skillPending) applySkills(st.skills);
    if (openIfRunning && st.running) show();
  }
  function resyncChat() {
    send({ type: "getState" })
      .then((st) => applyState(st, false))
      .catch(() => {});
  }

  // Window mode: the background talks to the docked window over this port (PLAN T12a). A dropped port (the
  // background was unloaded, or the window is closing) is re-opened, which wakes the background and re-reads the chat.
  function connectPanelPort() {
    let port;
    try {
      port = api.runtime.connect({ name: "claude-panel" });
    } catch (e) {
      setTimeout(connectPanelPort, 1000);
      return;
    }
    panelPort = port;
    port.onMessage.addListener((msg) => {
      handleBackground(msg, (r) => {
        try {
          port.postMessage({ type: "confirmResult", id: msg && msg.id, result: r && r.result });
        } catch (e) {
          // port gone: the background declines a prompt it never got an answer for
        }
      });
    });
    port.onDisconnect.addListener(() => {
      if (panelPort === port) panelPort = null;
      resolveApproval(false); // no way to answer the background any more: the pending prompt ends as declined
      setTimeout(() => {
        connectPanelPort();
        resyncChat();
      }, 1000);
    });
  }

  // ---------- terminal keep-alive (PLAN T13b.5) ----------
  // While the background says this tab is shared, this page keeps a "claude-keepalive" port open so the
  // background stays awake. A dropped port is reopened after 1 s, as long as the tab is still shared.
  let keepWanted = false;
  let keepPort = null;
  let keepTimer = null;
  function keepAliveConnect() {
    if (!keepWanted || keepPort) return;
    try {
      keepPort = api.runtime.connect({ name: "claude-keepalive" });
    } catch (e) {
      keepPort = null;
      keepAliveRetry();
      return;
    }
    keepPort.onDisconnect.addListener(() => {
      keepPort = null;
      keepAliveRetry();
    });
  }
  function keepAliveRetry() {
    if (!keepWanted || keepTimer) return;
    keepTimer = setTimeout(() => {
      keepTimer = null;
      keepAliveConnect();
    }, 1000);
  }
  function setShared(on) {
    keepWanted = on;
    if (on) {
      keepAliveConnect();
      return;
    }
    clearTimeout(keepTimer);
    keepTimer = null;
    const p = keepPort;
    keepPort = null;
    if (p) {
      try {
        p.disconnect();
      } catch (e) {
        // already gone
      }
    }
  }

  // Panel mode builds and attaches the panel. Terminal mode never does. The background answers "pageMode" with
  // its MODE; a window page (panel.html) always starts the panel.
  function startPanel() {
    if (panelMode) return;
    panelMode = true;
    (document.documentElement || document.body).appendChild(host);
    if (WINDOW_MODE) {
      connectPanelPort();
      show(); // the docked window is always shown
      setTimeout(revealWindowHost, 1500);
    }
    setRunning(false);
    refreshView();
    loadModel();
    send({ type: "getState" })
      .then((st) => applyState(st, true))
      .catch(() => {});
  }
  if (WINDOW_MODE) startPanel();
  else
    send({ type: "pageMode" })
      .then((r) => {
        if (r && r.mode === "panel") startPanel();
      })
      .catch(() => {});
})();
