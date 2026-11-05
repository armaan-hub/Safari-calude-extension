#!/usr/bin/env node
// Claude for Safari — MCP server for Claude Code (PLAN T13a).
// Newline-delimited JSON-RPC 2.0 on stdio. Tool calls go to the local bridge (127.0.0.1, SAFARI_BRIDGE_PORT, default 8787),
// which queues them for the Safari extension. Built-ins only.
// stdout carries JSON-RPC and nothing else; logs go to stderr.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describeToolCall } from "./jobwatch-activity.mjs";
import { loadSites, urlAllowed } from "./sites.mjs";
import { appendActivity, stateDir } from "./jobwatch-state.mjs";
import { bridgeHomePath } from './paths.mjs';

const BRIDGE_PORT = Number(process.env.SAFARI_BRIDGE_PORT) || 8787;
const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}`;
const TOKEN_FILE = bridgeHomePath("mcp-token");
// Switch file set by the user: while it exists, the one click that opens a LinkedIn Easy Apply form is allowed without asking.
const AUTO_ALLOW_FILE = bridgeHomePath("auto-allow-apply");
const AUTO_ALLOW_LABEL = /^click\s+[\u201C"']?easy apply(?: to this job)?[\u201D"']?\s*$/i;
const AUTO_ALLOW_MAX = 10;
const AUTO_ALLOW_WINDOW_MS = 60 * 60_000;
const autoAllowTimes = []; // timestamps (ms) of auto-allows in this process
const DEFAULT_PROTOCOL = "2025-06-18";
const SERVER_INFO = { name: "safari", version: "0.1.0" };
// The bridge answers after at most 90 s; leave a margin.
const HTTP_TIMEOUT_MS = 100_000;
// After needs_approval the human has up to 5 min; the bridge then waits for the action's final result.
const APPROVAL_MS = 5 * 60_000;
const APPROVAL_HTTP_TIMEOUT_MS = 420_000;
const NOT_RUNNING = `Safari bridge not running (127.0.0.1:${BRIDGE_PORT}). Start it with bridge/install.sh.`;
// Deny-risky mode (Job Watcher): risky actions are declined and submitting keys are refused. Off unless the env var is "1".
const DENY_RISKY = process.env.SAFARI_MCP_DENY_RISKY === "1";
const DENY_MESSAGE = "Blocked: the Job Watcher never submits, sends or posts. Do not retry this action.";
const DENY_NAV_MESSAGE = "Blocked: the Job Watcher may only open LinkedIn pages.";
const DENY_BUDGET_MESSAGE = "Blocked: the Job Watcher's tool-call budget for this run is used up. Give your final answer now.";
// Deny mode only: the only keys that may be pressed (compared trimmed and lower-cased).
const DENY_KEYS = new Set(["tab", "escape", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end", "pageup", "pagedown"]);
// Deny mode only: optional cap on tool calls per run (positive integer; anything else = no cap).
const MAX_CALLS = DENY_RISKY && /^[1-9][0-9]*$/.test(process.env.SAFARI_MCP_MAX_CALLS ?? "") ? Number(process.env.SAFARI_MCP_MAX_CALLS) : null;
let callCount = 0;

// Terminal mode: the host shown in the refusal, from the URL when it parses, else a placeholder.
function urlHostForMessage(url) {
  try {
    return new URL(url).hostname || "<host>";
  } catch {
    return "<host>";
  }
}

function allowedDenyUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && (u.hostname === "linkedin.com" || u.hostname.endsWith(".linkedin.com"));
}

function log(...parts) {
  process.stderr.write(`[safari-mcp] ${parts.join(" ")}\n`);
}

// ---------- live activity feed ----------
// Every Safari tool call writes one plain-English line to the Job Watcher feed (activity.log). The watcher's MCP
// config sets SAFARI_MCP_SOURCE=watcher; a terminal session has no such variable. Logging never throws and never
// changes a tool result.
const SOURCE = process.env.SAFARI_MCP_SOURCE === "watcher" ? "watcher" : "terminal";
const FEED_SUFFIX_MAX = 80;
const FEED_ERROR_MAX = 120;
const FEED_LABEL_MAX = 100;
const RESULT_TEXT_TOOLS = new Set(["click", "type", "navigate", "press_key", "scroll"]);
const LENGTH_TOOLS = new Set(["read_page", "get_page_text"]);

function feedLine(line) {
  try {
    appendActivity(stateDir(), line);
  } catch {
    // The feed is best effort: an unwritable directory must not affect the tool.
  }
}

function collapseText(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function resultText(result) {
  const parts = Array.isArray(result.content) ? result.content : [];
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

// The outcome part of a feed line: result text, character count, or the refusal or error.
function outcomeSuffix(name, result) {
  const text = resultText(result);
  if (result.isError) {
    const message = text.replace(/^Error:\s*/, "");
    if (message.startsWith("Blocked:")) {
      return ` -> blocked: ${collapseText(message.slice("Blocked:".length)).slice(0, FEED_ERROR_MAX)}`;
    }
    return ` -> error: ${collapseText(message).slice(0, FEED_ERROR_MAX)}`;
  }
  if (LENGTH_TOOLS.has(name)) return ` (${text.length} chars)`;
  if (RESULT_TEXT_TOOLS.has(name) && collapseText(text)) {
    return ` -> ${collapseText(text).slice(0, FEED_SUFFIX_MAX)}`;
  }
  return "";
}

function logCall(name, args, result) {
  try {
    if (name === "safari_status") return;
    const what = describeToolCall(name, args, { showTyped: SOURCE === "watcher" });
    feedLine(`[${SOURCE}] ${what}${outcomeSuffix(name, result)}`);
  } catch {
    // Logging must never change the result.
  }
}

process.stdout.on("error", () => process.exit(0));

// ---------- JSON-RPC output ----------

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------- tool definitions ----------
// Schemas are copied from TOOLS in extension/background.js, plus a required integer tab_id.

const SHARE_NOTE = " Works only on tabs the user shared with Claude; use safari_status to find tab_id.";
const TAB_ID = { type: "integer", description: "Id of a shared tab (from safari_status)." };
const REF = { type: "string", description: "Element ref from read_page, e.g. ref_3." };

function tabTool(name, description, properties = {}, required = []) {
  return {
    name,
    description: description + SHARE_NOTE,
    inputSchema: {
      type: "object",
      properties: { tab_id: TAB_ID, ...properties },
      required: ["tab_id", ...required],
    },
  };
}

const TOOL_DEFS = [
  tabTool(
    "read_page",
    "Return a text outline of the page. mode 'interactive' (default) lists links, buttons, inputs and headings with refs; mode 'all' also includes visible text. Use the refs with click and type.",
    { mode: { type: "string", enum: ["interactive", "all"] } },
  ),
  tabTool("get_page_text", "Return the visible text of the page (main content preferred), truncated to ~30k chars."),
  tabTool(
    "click",
    "Click an element by ref from read_page. Call read_page first. Risky clicks (submit, buy, send, delete) need the user's approval: the call waits while the user is asked, and returns an error if they decline. Do not retry a declined action.",
    { ref: REF },
    ["ref"],
  ),
  tabTool(
    "type",
    "Focus an element by ref (from read_page) and type text into it. clear=true replaces existing content; submit=true presses Enter afterwards. Call read_page first. Never type passwords, card numbers or 2FA codes; ask the user to enter those.",
    {
      ref: REF,
      text: { type: "string" },
      clear: { type: "boolean" },
      submit: { type: "boolean" },
    },
    ["ref", "text"],
  ),
  tabTool(
    "press_key",
    "Press a key (e.g. Enter, Escape, Tab, ArrowDown) on the focused element.",
    { key: { type: "string" } },
    ["key"],
  ),
  tabTool(
    "scroll",
    "Scroll the page. direction: up | down | top | bottom. Or pass ref to scroll an element into view.",
    { direction: { type: "string", enum: ["up", "down", "top", "bottom"] }, ref: REF },
  ),
  tabTool(
    "navigate",
    "Navigate the shared tab to a URL (http/https only) and wait for it to load.",
    { url: { type: "string" } },
    ["url"],
  ),
  tabTool(
    "open_tab",
    "Open a new background tab at an https URL on the user's allowed sites list, in the same window as the shared tab tab_id. The new tab is shared automatically so you can continue there. Limited to 5 per hour and 10 shared tabs.",
    { url: { type: "string", description: "https URL on the allowed list" } },
    ["url"],
  ),
  tabTool(
    "wait",
    "Wait a number of seconds (max 10) for the page to update, e.g. after a click. Then call read_page again.",
    { seconds: { type: "number" } },
    ["seconds"],
  ),
  tabTool(
    "screenshot",
    "Capture the visible part of the shared tab as an image. If the tab is not the active tab, the user must bring it to the front.",
  ),
  {
    name: "safari_status",
    description:
      "Show whether the Safari extension is connected and which tabs the user shared (tab_id, title, url). Call this first to find tab_id.",
    inputSchema: { type: "object", properties: {} },
  },
];

const TOOL_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));

// open_tab exists only in terminal mode: the Job Watcher (SOURCE watcher) and deny-risky mode never see it.
function toolVisible(name) {
  return !(name === "open_tab" && (SOURCE === "watcher" || DENY_RISKY));
}

// Checks the arguments against the tool's schema (types, enums, required). Returns an error message, or null.
function validate(name, args) {
  if (name === "safari_status") return null;
  if (!Number.isInteger(args.tab_id)) return "tab_id (integer) is required. Call safari_status to see shared tabs.";
  const schema = TOOL_BY_NAME.get(name).inputSchema;
  for (const key of schema.required) {
    if (args[key] === undefined) return `${key} is required.`;
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = args[key];
    if (v === undefined) continue;
    if (spec.type === "string" && typeof v !== "string") return `${key} must be a string.`;
    if (spec.type === "boolean" && typeof v !== "boolean") return `${key} must be true or false.`;
    if (spec.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) return `${key} must be a number.`;
    if (spec.type === "integer" && !Number.isInteger(v)) return `${key} must be an integer.`;
    if (spec.enum && !spec.enum.includes(v)) return `${key} must be one of: ${spec.enum.join(", ")}.`;
    if (spec.type === "string" && key !== "text" && v.trim() === "") return `${key} must not be empty.`;
  }
  if (name === "scroll" && args.direction === undefined && args.ref === undefined) return "scroll needs direction or ref.";
  return null;
}

// Only the schema's own keys travel to the extension.
function cleanArgs(name, args) {
  const out = {};
  for (const key of Object.keys(TOOL_BY_NAME.get(name).inputSchema.properties)) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

// ---------- bridge HTTP ----------

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Calls the bridge and returns the parsed JSON body. Throws Error(message) on failure.
async function bridge(method, route, token, body, timeoutMs = HTTP_TIMEOUT_MS) {
  let res;
  try {
    res = await fetch(BRIDGE + route, {
      method,
      headers: {
        "x-safari-mcp-token": token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e && e.name === "TimeoutError") throw new Error("Safari bridge did not answer in time.");
    throw new Error(NOT_RUNNING);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = json && json.error && json.error.message;
    throw new Error(msg || `Safari bridge returned HTTP ${res.status}.`);
  }
  if (!json || typeof json !== "object") throw new Error("Safari bridge sent an unreadable answer.");
  return json;
}

// ---------- results ----------

function errorResult(message) {
  const text = message.startsWith("Error:") ? message : `Error: ${message}`;
  return { content: [{ type: "text", text }], isError: true };
}

// Map the bridge's answer for a queued tool call to MCP content.
function toolResult(data) {
  if (typeof data.error === "string") return errorResult(data.error);
  const content = [];
  if (typeof data.text === "string") content.push({ type: "text", text: data.text });
  if (typeof data.image === "string") {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(data.image);
    if (m) content.push({ type: "image", data: m[2], mimeType: m[1] });
    else content.push({ type: "text", text: "The screenshot came back in an unknown format." });
  }
  if (content.length === 0) content.push({ type: "text", text: JSON.stringify(data) });
  return { content };
}

function statusResult(status) {
  const tabs = Array.isArray(status.sharedTabs) ? status.sharedTabs : [];
  const lines = [
    status.connected
      ? "Extension: connected."
      : "Extension: not answering. Check that Safari is open and the user has shared a tab (Claude icon shows ON).",
  ];
  if (tabs.length === 0) {
    lines.push("No tabs shared. Ask the user to click the Claude icon on the tab they want you to use.");
  } else {
    lines.push("Shared tabs (use tab_id):");
    for (const t of tabs) lines.push(`- tab_id ${t.tabId}: ${t.title || "(no title)"} ${t.url || ""}`.trimEnd());
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------- approvals ----------
// The model never approves anything. A risky action comes back as {needs_approval, approval_id, label}; this
// server (not a tool) then asks the human: through MCP elicitation when the client supports it, otherwise the
// extension shows Allow / Deny on the page itself. The decision goes to the bridge's /mcp/approval route.

let clientCanElicit = false;
let outSeq = 0;
const outPending = new Map(); // request id -> resolve(response message)

// Sends a request to the client and resolves with its response, or null on timeout.
function clientRequest(method, params, timeoutMs) {
  const id = `safari-mcp-${++outSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      outPending.delete(id);
      write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "timed out" } });
      resolve(null);
    }, timeoutMs);
    outPending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    write({ jsonrpc: "2.0", id, method, params });
  });
}

function approvalQuestion(data) {
  let label = typeof data.label === "string" ? data.label.replace(/^Claude wants to\s+/i, "").trim() : "";
  if (!label) label = "perform an action on the page";
  const where = [data.tab_title, data.tab_url].filter((x) => typeof x === "string" && x).join(" - ");
  return { label, text: `Claude wants to: ${label}${where ? ` on ${where.slice(0, 200)}` : ""}. Allow?` };
}

// Asks the human through the client. true only for action "accept" with content.allow === true.
async function elicitAllow(question) {
  const r = await clientRequest(
    "elicitation/create",
    {
      message: question,
      requestedSchema: {
        type: "object",
        properties: { allow: { type: "boolean", title: "Allow this action", default: false } },
        required: ["allow"],
      },
    },
    APPROVAL_MS
  );
  return !!(r && !r.error && r.result && r.result.action === "accept" && r.result.content && r.result.content.allow === true);
}

// True only for the Easy Apply open click, with the switch file present, an allowed site and fewer than
// AUTO_ALLOW_MAX auto-allows in the last hour. Recording the allow happens here, when it is granted.
function autoAllowApply(data) {
  try {
    if (!fs.existsSync(AUTO_ALLOW_FILE)) return false;
    if (DENY_RISKY) return false;
    const label = approvalQuestion(data).label;
    if (!AUTO_ALLOW_LABEL.test(label)) return false;
    if (typeof data.tab_url !== "string" || !urlAllowed(data.tab_url, loadSites())) return false;
    const now = Date.now();
    while (autoAllowTimes.length && now - autoAllowTimes[0] > AUTO_ALLOW_WINDOW_MS) autoAllowTimes.shift();
    if (autoAllowTimes.length >= AUTO_ALLOW_MAX) return false;
    autoAllowTimes.push(now);
    return true;
  } catch {
    return false;
  }
}

async function handleApproval(data, token) {
  if (typeof data.approval_id !== "string" || !data.approval_id) return errorResult("Safari sent a malformed approval request.");
  if (DENY_RISKY) {
    // Never approved: the bridge is told "no" and the model gets a refusal it must not retry.
    await bridge("POST", "/mcp/approval", token, { approval_id: data.approval_id, approve: false }, APPROVAL_HTTP_TIMEOUT_MS);
    return errorResult(DENY_MESSAGE);
  }
  const q = approvalQuestion(data);
  let body;
  if (autoAllowApply(data)) {
    feedLine(`[${SOURCE}] auto-allowed opening the Easy Apply form (switch file present); Submit still needs the human`);
    body = { approval_id: data.approval_id, approve: true };
  } else {
    feedLine(`[${SOURCE}] waiting for your Allow in Safari: ${collapseText(q.label).slice(0, FEED_LABEL_MAX)}`);
    if (clientCanElicit) {
      const allow = await elicitAllow(q.text);
      body = { approval_id: data.approval_id, approve: allow };
    } else {
      body = { approval_id: data.approval_id }; // the human answers on the page; this call just waits
    }
  }
  const final = await bridge("POST", "/mcp/approval", token, body, APPROVAL_HTTP_TIMEOUT_MS);
  if (final.needs_approval) return errorResult("Safari asked for approval twice for one action; nothing more was done.");
  // The extension worker restarted before the human answered: nothing was clicked. Tell the caller to re-ask once.
  if (typeof final.error === "string" && final.error.startsWith("Approval lost")) return { approvalLost: true };
  if (typeof final.error !== "string" && body.approve === false) return errorResult(`User declined: ${q.label}`);
  return toolResult(final);
}

async function runTool(name, args) {
  const result = await runToolChecked(name, args);
  logCall(name, args, result);
  return result;
}

async function runToolChecked(name, args) {
  if (DENY_RISKY) {
    // Deny-risky mode: budget, key allowlist, LinkedIn-only navigation and non-submitting typing; all before the bridge.
    if (name !== "safari_status" && MAX_CALLS !== null && ++callCount > MAX_CALLS) return errorResult(DENY_BUDGET_MESSAGE);
    if (name === "press_key" && !(typeof args.key === "string" && DENY_KEYS.has(args.key.trim().toLowerCase()))) {
      return errorResult(DENY_MESSAGE);
    }
    if (name === "navigate" && !(typeof args.url === "string" && allowedDenyUrl(args.url.trim()))) {
      return errorResult(DENY_NAV_MESSAGE);
    }
    if (name === "type" && args.submit === true) return errorResult(DENY_MESSAGE);
  }
  // Terminal mode: navigation (and opening a tab) only to the user's allowed sites. The list is read on every call.
  if (!DENY_RISKY && (name === "navigate" || name === "open_tab") && !urlAllowed(args.url, loadSites())) {
    return errorResult(
      `Blocked: this site is not on the user's allowed list. Call site_request with host ${urlHostForMessage(args.url)}, country and reason, then carry on with the allowed sites. The user approves it with: node bridge/sites.mjs approve ${urlHostForMessage(args.url)} (node bridge/sites.mjs pending lists requests). Never edit the allowed list.`
    );
  }
  const bad = validate(name, args);
  if (bad) return errorResult(bad);
  const token = readToken();
  if (!token) return errorResult(`Safari bridge token not found at ${TOKEN_FILE}. Run bridge/install.sh.`);
  try {
    if (name === "safari_status") return statusResult(await bridge("GET", "/mcp/status", token));
    const callBody = { tool: name, args: cleanArgs(name, args), elicit: clientCanElicit };
    const data = await bridge("POST", "/mcp/call", token, callBody);
    if (!data.needs_approval) return toolResult(data);
    const first = await handleApproval(data, token);
    if (!(first && first.approvalLost === true)) return first;
    // Safari lost the approval (extension restart). Ask once more with the same request; the human must Allow again.
    feedLine(`[${SOURCE}] Safari lost the approval; asking again once`);
    const data2 = await bridge("POST", "/mcp/call", token, callBody);
    if (!data2.needs_approval) return toolResult(data2);
    const second = await handleApproval(data2, token);
    if (second && second.approvalLost === true) {
      return errorResult("Safari lost the approval twice; the action may not have been done. Check the page, reload the tab if needed, and try again.");
    }
    return second;
  } catch (e) {
    return errorResult(e.message);
  }
}

// ---------- JSON-RPC dispatch ----------

async function onRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      clientCanElicit = !!(params && params.capabilities && typeof params.capabilities === "object" && params.capabilities.elicitation);
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOL_DEFS.filter((t) => toolVisible(t.name)) });
    case "tools/call": {
      const name = params?.name;
      if (typeof name !== "string" || !TOOL_BY_NAME.has(name) || !toolVisible(name)) {
        return fail(id, -32602, `Unknown tool: ${name}`);
      }
      const args = params.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return fail(id, -32602, "arguments must be an object");
      }
      return reply(id, await runTool(name, args));
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return fail(null, -32700, "Parse error");
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return fail(null, -32600, "Invalid Request");
  if (typeof msg.method !== "string") {
    // A reply to one of our requests (elicitation) goes to its waiter; anything else is invalid.
    if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
      const waiter = outPending.get(msg.id);
      if (waiter) {
        outPending.delete(msg.id);
        waiter(msg);
      }
    } else if (msg.id !== undefined) fail(msg.id, -32600, "Invalid Request");
    return;
  }
  // Notifications (no id, e.g. notifications/initialized) get no reply.
  if (!("id" in msg)) return;
  onRequest(msg).catch((e) => {
    log("handler error:", e.message);
    fail(msg.id, -32603, "Internal error");
  });
});

log(`ready (bridge ${BRIDGE})`);
