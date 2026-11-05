// Tests for the allowed-sites check on navigate in terminal mode (bridge/safari-mcp.mjs).
// Built-ins only. A fake bridge runs on a random port; HOME, the sites file and JOBWATCH_DIR are temp paths,
// so the real ~/.claude-safari-bridge is never touched. Fictional data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "safari-mcp.mjs");
const CALL_TIMEOUT_MS = 10_000;
const ALLOW_MESSAGE = "Blocked: this site is not on the user's allowed list. Call site_request with host";

function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Fake bridge: records every request and answers with plain text.
function startFakeBridge(seen) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, route: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "forwarded" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// sitesFile: "absent" (no file), or the exact text to write into the sites file.
async function startServer({ sitesFile = "absent", extraEnv = {} } = {}) {
  const seen = [];
  const bridge = await startFakeBridge(seen);
  const port = bridge.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safari-mcp-sites-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".claude-safari-bridge"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude-safari-bridge", "mcp-token"), "test-token\n");
  const sites = path.join(root, "allowed-sites.json");
  if (sitesFile !== "absent") fs.writeFileSync(sites, sitesFile);
  const jobwatchDir = path.join(root, "jobwatch");

  // Minimal environment: the sites file and feed directory are temp paths; deny mode is absent unless extraEnv sets it.
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      SAFARI_BRIDGE_PORT: String(port),
      SAFARI_SITES_FILE: sites,
      JOBWATCH_DIR: jobwatchDir,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });

  const pending = new Map();
  let nextId = 1;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  });

  function send(method, params) {
    const id = nextId++;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return withTimeout(answer, CALL_TIMEOUT_MS, method);
  }

  async function initialize() {
    await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  async function call(name, args) {
    const reply = await send("tools/call", { name, arguments: args });
    return reply.result;
  }

  // The whole JSON-RPC reply (for refusals that come back as a protocol error, such as an unknown tool).
  function callReply(name, args) {
    return send("tools/call", { name, arguments: args });
  }

  async function listTools() {
    const reply = await send("tools/list", {});
    return reply.result.tools;
  }

  function activityText() {
    const file = path.join(jobwatchDir, "activity.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  async function close() {
    rl.close();
    child.stdin.end();
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", resolve);
    });
    child.kill();
    await exited;
    bridge.closeAllConnections();
    await new Promise((resolve) => bridge.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }

  const callsTo = (route) => seen.filter((r) => r.route === route);
  return { seen, sitesPath: sites, initialize, call, callReply, listTools, close, callsTo, activityText };
}

const LINKEDIN_ONLY = JSON.stringify(["linkedin.com"]);

test("terminal mode: navigate to a site not on the list is refused before the bridge is contacted", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    const result = await srv.call("navigate", { tab_id: 1, url: "https://example.com" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: Blocked: this site is not on the user's allowed list/);
    assert.ok(result.content[0].text.includes("node bridge/sites.mjs approve example.com"));
    assert.equal(srv.callsTo("/mcp/call").length, 0, "the bridge must receive no request");
  } finally {
    await srv.close();
  }
});

test("terminal mode: navigate to a listed site (subdomain) reaches the bridge", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    const result = await srv.call("navigate", { tab_id: 1, url: "https://www.linkedin.com/jobs" });
    assert.notEqual(result.isError, true);
    const calls = srv.callsTo("/mcp/call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.tool, "navigate");
  } finally {
    await srv.close();
  }
});

test("terminal mode: lookalike hosts are refused and name the real host", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    for (const url of ["https://linkedin.com.evil.test/", "https://evil-linkedin.com/", "https://linkedin.com@evil.test/", "http://linkedin.com/"]) {
      const result = await srv.call("navigate", { tab_id: 1, url });
      assert.equal(result.isError, true, `${url} must be refused`);
    }
    assert.equal(srv.callsTo("/mcp/call").length, 0);
    const r = await srv.call("navigate", { tab_id: 1, url: "https://linkedin.com.evil.test/" });
    assert.ok(r.content[0].text.includes("node bridge/sites.mjs approve linkedin.com.evil.test"));
  } finally {
    await srv.close();
  }
});

test("terminal mode: an unparseable URL is refused with the literal <host> placeholder", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    const result = await srv.call("navigate", { tab_id: 1, url: "not a url" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("node bridge/sites.mjs approve <host>"));
    assert.equal(srv.callsTo("/mcp/call").length, 0);
  } finally {
    await srv.close();
  }
});

test("terminal mode: an empty list file blocks linkedin too", async () => {
  const srv = await startServer({ sitesFile: "[]" });
  try {
    await srv.initialize();
    const result = await srv.call("navigate", { tab_id: 1, url: "https://www.linkedin.com/jobs" });
    assert.equal(result.isError, true);
    assert.equal(srv.callsTo("/mcp/call").length, 0);
  } finally {
    await srv.close();
  }
});

test("terminal mode: a corrupt sites file blocks everything", async () => {
  const srv = await startServer({ sitesFile: "{ not json" });
  try {
    await srv.initialize();
    for (const url of ["https://example.com", "https://www.linkedin.com/jobs"]) {
      const result = await srv.call("navigate", { tab_id: 1, url });
      assert.equal(result.isError, true, `${url} must be refused`);
    }
    assert.equal(srv.callsTo("/mcp/call").length, 0);
  } finally {
    await srv.close();
  }
});

test("terminal mode: a missing sites file allows linkedin only", async () => {
  const srv = await startServer({ sitesFile: "absent" });
  try {
    await srv.initialize();
    const blocked = await srv.call("navigate", { tab_id: 1, url: "https://example.com" });
    assert.equal(blocked.isError, true);
    const allowed = await srv.call("navigate", { tab_id: 1, url: "https://linkedin.com/feed" });
    assert.notEqual(allowed.isError, true);
    assert.equal(srv.callsTo("/mcp/call").length, 1);
  } finally {
    await srv.close();
  }
});

test("terminal mode: a refusal is written to the activity feed as blocked", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    await srv.call("navigate", { tab_id: 1, url: "https://example.com" });
    const feed = srv.activityText();
    assert.match(feed, /\[terminal\] .*-> blocked: this site is not on the user's allowed list/);
  } finally {
    await srv.close();
  }
});

test("terminal mode: the list is read on each call, so edits take effect at once", async () => {
  const srv = await startServer({ sitesFile: "[]" });
  try {
    await srv.initialize();
    const first = await srv.call("navigate", { tab_id: 1, url: "https://www.linkedin.com/jobs" });
    assert.equal(first.isError, true);
    fs.writeFileSync(srv.sitesPath, LINKEDIN_ONLY);
    const second = await srv.call("navigate", { tab_id: 1, url: "https://www.linkedin.com/jobs" });
    assert.notEqual(second.isError, true);
    assert.equal(srv.callsTo("/mcp/call").length, 1);
  } finally {
    await srv.close();
  }
});

test("watcher (deny-risky) mode: navigate keeps the deny rule and is not subject to the allowed list", async () => {
  const srv = await startServer({
    sitesFile: JSON.stringify(["example.com"]),
    extraEnv: { SAFARI_MCP_DENY_RISKY: "1", SAFARI_MCP_SOURCE: "watcher" },
  });
  try {
    await srv.initialize();
    // example.com is on the user's list, but the watcher may only open LinkedIn pages.
    const denied = await srv.call("navigate", { tab_id: 1, url: "https://example.com" });
    assert.equal(denied.isError, true);
    assert.equal(denied.content[0].text, "Error: Blocked: the Job Watcher may only open LinkedIn pages.");
    assert.equal(srv.callsTo("/mcp/call").length, 0);
    const allowed = await srv.call("navigate", { tab_id: 1, url: "https://www.linkedin.com/jobs" });
    assert.notEqual(allowed.isError, true);
    assert.equal(srv.callsTo("/mcp/call").length, 1);
  } finally {
    await srv.close();
  }
});

test("terminal mode: navigate with a non-string url is refused before the bridge is contacted", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    const result = await srv.call("navigate", { tab_id: 1, url: ["https://www.linkedin.com/jobs"] });
    assert.equal(result.isError, true);
    assert.equal(srv.callsTo("/mcp/call").length, 0, "the bridge must receive no request");
  } finally {
    await srv.close();
  }
});

test("terminal mode: tools/list includes open_tab with required tab_id and url", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    const tool = (await srv.listTools()).find((t) => t.name === "open_tab");
    assert.ok(tool, "open_tab must be listed in terminal mode");
    assert.deepEqual(tool.inputSchema.required, ["tab_id", "url"]);
    assert.equal(tool.inputSchema.properties.url.type, "string");
    assert.equal(tool.inputSchema.properties.tab_id.type, "integer");
  } finally {
    await srv.close();
  }
});

test("watcher mode: open_tab is absent from tools/list and a call is refused like an unknown tool", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY, extraEnv: { SAFARI_MCP_SOURCE: "watcher" } });
  try {
    await srv.initialize();
    assert.equal((await srv.listTools()).some((t) => t.name === "open_tab"), false);
    const reply = await srv.callReply("open_tab", { tab_id: 1, url: "https://www.linkedin.com/jobs" });
    assert.equal(reply.error?.code, -32602);
    assert.equal(reply.error.message, "Unknown tool: open_tab");
    assert.equal(srv.callsTo("/mcp/call").length, 0, "the bridge must receive no request");
  } finally {
    await srv.close();
  }
});

test("deny-risky mode: open_tab is absent from tools/list and a call is refused like an unknown tool", async () => {
  const srv = await startServer({
    sitesFile: LINKEDIN_ONLY,
    extraEnv: { SAFARI_MCP_DENY_RISKY: "1", SAFARI_MCP_SOURCE: "watcher" },
  });
  try {
    await srv.initialize();
    assert.equal((await srv.listTools()).some((t) => t.name === "open_tab"), false);
    const reply = await srv.callReply("open_tab", { tab_id: 1, url: "https://www.linkedin.com/jobs" });
    assert.equal(reply.error?.message, "Unknown tool: open_tab");
    assert.equal(srv.callsTo("/mcp/call").length, 0);
  } finally {
    await srv.close();
  }
});

test("terminal mode: open_tab to a site not on the list is refused before the bridge is contacted", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    const result = await srv.call("open_tab", { tab_id: 1, url: "https://example.com" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: Blocked: this site is not on the user's allowed list/);
    assert.ok(result.content[0].text.includes("node bridge/sites.mjs approve example.com"));
    assert.equal(srv.callsTo("/mcp/call").length, 0, "the bridge must receive no request");
  } finally {
    await srv.close();
  }
});

test("terminal mode: open_tab to a listed site reaches the bridge with only tab_id and url", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    const url = "https://www.linkedin.com/jobs?x=SECRET";
    const result = await srv.call("open_tab", { tab_id: 1, url, submit: true, ref: "ref_1" });
    assert.notEqual(result.isError, true);
    const calls = srv.callsTo("/mcp/call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.tool, "open_tab");
    assert.deepEqual(calls[0].body.args, { tab_id: 1, url });
  } finally {
    await srv.close();
  }
});

test("terminal mode: the open_tab log line shows host and path but never the query string", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    await srv.call("open_tab", { tab_id: 1, url: "https://www.linkedin.com/jobs?x=SECRET" });
    const feed = srv.activityText();
    assert.match(feed, /\[terminal\] opening www\.linkedin\.com\/jobs in a new tab/);
    assert.equal(feed.includes("SECRET"), false, "the query string must not reach activity.log");
  } finally {
    await srv.close();
  }
});

test("terminal mode: open_tab with a missing url is refused by validation before the bridge", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    const result = await srv.call("open_tab", { tab_id: 1 });
    assert.equal(result.isError, true);
    assert.equal(srv.callsTo("/mcp/call").length, 0);
  } finally {
    await srv.close();
  }
});

test("terminal mode: a ?trk=SECRET query never reaches activity.log for a blocked or an allowed navigate", async () => {
  const srv = await startServer({ sitesFile: LINKEDIN_ONLY });
  try {
    await srv.initialize();
    const blocked = await srv.call("navigate", { tab_id: 1, url: "https://example.com/a?trk=SECRET" });
    assert.equal(blocked.isError, true);
    const allowed = await srv.call("navigate", { tab_id: 1, url: "https://www.linkedin.com/jobs?trk=SECRET#SECRET2" });
    assert.notEqual(allowed.isError, true);
    const feed = srv.activityText();
    assert.match(feed, /opening example\.com\/a -> blocked:/);
    assert.match(feed, /opening www\.linkedin\.com\/jobs/);
    assert.equal(feed.includes("SECRET"), false, "no query string or fragment may reach activity.log");
  } finally {
    await srv.close();
  }
});
