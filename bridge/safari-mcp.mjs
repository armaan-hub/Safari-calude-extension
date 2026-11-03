#!/usr/bin/env node
// Claude for Safari — MCP server for Claude Code (PLAN T13a).
// Newline-delimited JSON-RPC 2.0 on stdio. Tool calls go to the local bridge (127.0.0.1:8787),
// which queues them for the Safari extension. Built-ins only.
// stdout carries JSON-RPC and nothing else; logs go to stderr.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const BRIDGE_PORT = Number(process.env.SAFARI_BRIDGE_PORT) || 8787;
const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}`;
const TOKEN_FILE = path.join(os.homedir(), ".claude-safari-bridge", "mcp-token");
const DEFAULT_PROTOCOL = "2025-06-18";
const SERVER_INFO = { name: "safari", version: "0.1.0" };
// The bridge answers after at most 90 s; leave a margin.
const HTTP_TIMEOUT_MS = 100_000;
// After needs_approval the human has up to 5 min; the bridge then waits for the action's final result.
const APPROVAL_MS = 5 * 60_000;
const APPROVAL_HTTP_TIMEOUT_MS = 420_000;
const NOT_RUNNING = `Safari bridge not running (127.0.0.1:${BRIDGE_PORT}). Start it with bridge/install.sh.`;

function log(...parts) {
  process.stderr.write(`[safari-mcp] ${parts.join(" ")}\n`);
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

async function handleApproval(data, token) {
  if (typeof data.approval_id !== "string" || !data.approval_id) return errorResult("Safari sent a malformed approval request.");
  const q = approvalQuestion(data);
  let body;
  if (clientCanElicit) {
    const allow = await elicitAllow(q.text);
    body = { approval_id: data.approval_id, approve: allow };
  } else {
    body = { approval_id: data.approval_id }; // the human answers on the page; this call just waits
  }
  const final = await bridge("POST", "/mcp/approval", token, body, APPROVAL_HTTP_TIMEOUT_MS);
  if (final.needs_approval) return errorResult("Safari asked for approval twice for one action; nothing more was done.");
  if (typeof final.error !== "string" && body.approve === false) return errorResult(`User declined: ${q.label}`);
  return toolResult(final);
}

async function runTool(name, args) {
  const bad = validate(name, args);
  if (bad) return errorResult(bad);
  const token = readToken();
  if (!token) return errorResult(`Safari bridge token not found at ${TOKEN_FILE}. Run bridge/install.sh.`);
  try {
    if (name === "safari_status") return statusResult(await bridge("GET", "/mcp/status", token));
    const data = await bridge("POST", "/mcp/call", token, { tool: name, args: cleanArgs(name, args), elicit: clientCanElicit });
    if (data.needs_approval) return await handleApproval(data, token);
    return toolResult(data);
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
      return reply(id, { tools: TOOL_DEFS });
    case "tools/call": {
      const name = params?.name;
      if (typeof name !== "string" || !TOOL_BY_NAME.has(name)) {
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
