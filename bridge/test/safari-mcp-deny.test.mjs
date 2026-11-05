// Tests for deny-risky mode in bridge/safari-mcp.mjs (SAFARI_MCP_DENY_RISKY=1).
// Built-ins only. A fake bridge runs on a random port; HOME is a temp dir, so the real token is never touched.

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

function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Fake bridge: records every request; answers risky clicks with needs_approval and approval decisions.
function startFakeBridge(seen) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, route: req.url, body });
      let out;
      if (req.url === "/mcp/call" && body.tool === "click") {
        out = { needs_approval: true, approval_id: "a1", label: "Claude wants to Submit" };
      } else if (req.url === "/mcp/approval") {
        out = body.approve === false ? { error: "declined" } : { text: "clicked" };
      } else {
        out = { text: "forwarded" };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function startServer(extraEnv) {
  const seen = [];
  const bridge = await startFakeBridge(seen);
  const port = bridge.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "safari-mcp-deny-"));
  fs.mkdirSync(path.join(home, ".claude-safari-bridge"));
  fs.writeFileSync(path.join(home, ".claude-safari-bridge", "mcp-token"), "test-token\n");

  // Minimal environment: the deny switch is absent unless extraEnv sets it.
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, HOME: home, SAFARI_BRIDGE_PORT: String(port), ...extraEnv },
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
    fs.rmSync(home, { recursive: true, force: true });
  }

  const callsTo = (route) => seen.filter((r) => r.route === route);
  return { seen, initialize, call, close, callsTo };
}

test("deny mode: risky click is auto-declined", async () => {
  const srv = await startServer({ SAFARI_MCP_DENY_RISKY: "1" });
  try {
    await srv.initialize();
    const started = Date.now();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.ok(Date.now() - started < 2000, "the decline must arrive within 2 s");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Blocked/);
    const approvals = srv.callsTo("/mcp/approval");
    assert.equal(approvals.length, 1, "the approval decision was posted once");
    assert.deepEqual(approvals[0].body, { approval_id: "a1", approve: false });
  } finally {
    await srv.close();
  }
});

test("deny mode: only allowlisted keys pass, everything else is refused", async () => {
  const srv = await startServer({ SAFARI_MCP_DENY_RISKY: "1" });
  try {
    await srv.initialize();
    const refusedKeys = ["Enter", "enter", "Return", "NumpadEnter", "Space", " ", "Control+Enter", "Meta+Return", "a", "F5", "Backspace", ""];
    for (const key of refusedKeys) {
      const result = await srv.call("press_key", { tab_id: 1, key });
      assert.equal(result.isError, true, `${JSON.stringify(key)} must be refused`);
    }
    for (const key of ["Enter", "Space", " ", "Control+Enter", "Meta+Return"]) {
      const result = await srv.call("press_key", { tab_id: 1, key });
      assert.match(result.content[0].text, /Blocked/, `${JSON.stringify(key)} gets the Blocked error`);
    }
    assert.equal(srv.callsTo("/mcp/call").length, 0, "refused keys never reach the bridge");

    const allowed = ["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", " tab ", "ESCAPE", "pagedown"];
    for (const key of allowed) {
      const result = await srv.call("press_key", { tab_id: 1, key });
      assert.notEqual(result.isError, true, `${key} must pass`);
    }
    assert.equal(srv.callsTo("/mcp/call").length, allowed.length, "allowlisted keys reached the bridge");
  } finally {
    await srv.close();
  }
});

test("deny mode: navigate only to https linkedin.com pages", async () => {
  const srv = await startServer({ SAFARI_MCP_DENY_RISKY: "1" });
  try {
    await srv.initialize();
    const refused = [
      "https://example.com/",
      "http://www.linkedin.com/jobs/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "not a url",
      "https://linkedin.com.evil.com/jobs",
      "https://evil.com/www.linkedin.com",
      "https://notlinkedin.com/",
      "https://www.linkedin.com@evil.com/",
    ];
    for (const url of refused) {
      const result = await srv.call("navigate", { tab_id: 1, url });
      assert.equal(result.isError, true, `${url} must be refused`);
      assert.match(result.content[0].text, /Blocked: the Job Watcher may only open LinkedIn pages\./);
    }
    assert.equal(srv.callsTo("/mcp/call").length, 0, "refused navigation never reaches the bridge");

    const allowed = ["https://www.linkedin.com/jobs/", "https://linkedin.com/", "https://uk.linkedin.com/jobs/view/1", "HTTPS://WWW.LINKEDIN.COM/jobs"];
    for (const url of allowed) {
      const result = await srv.call("navigate", { tab_id: 1, url });
      assert.notEqual(result.isError, true, `${url} must pass`);
    }
    assert.equal(srv.callsTo("/mcp/call").length, allowed.length);
  } finally {
    await srv.close();
  }
});

test("deny mode: tool-call budget blocks calls after the limit, safari_status is free", async () => {
  const srv = await startServer({ SAFARI_MCP_DENY_RISKY: "1", SAFARI_MCP_MAX_CALLS: "3" });
  try {
    await srv.initialize();
    for (let i = 0; i < 3; i++) {
      const r = await srv.call("wait", { tab_id: 1, seconds: 1 });
      assert.notEqual(r.isError, true, `call ${i + 1} is forwarded`);
    }
    assert.equal(srv.callsTo("/mcp/call").length, 3);
    const fourth = await srv.call("wait", { tab_id: 1, seconds: 1 });
    assert.equal(fourth.isError, true);
    assert.match(fourth.content[0].text, /tool-call budget for this run is used up\. Give your final answer now\./);
    assert.equal(srv.callsTo("/mcp/call").length, 3, "the fourth call never reaches the bridge");
    const status = await srv.call("safari_status", {});
    assert.notEqual(status.isError, true, "safari_status is not blocked");
    assert.equal(srv.callsTo("/mcp/status").length, 1);
    const fifth = await srv.call("wait", { tab_id: 1, seconds: 1 });
    assert.equal(fifth.isError, true);
  } finally {
    await srv.close();
  }
});

test("deny mode: invalid SAFARI_MCP_MAX_CALLS means no budget", async () => {
  const srv = await startServer({ SAFARI_MCP_DENY_RISKY: "1", SAFARI_MCP_MAX_CALLS: "abc" });
  try {
    await srv.initialize();
    for (let i = 0; i < 5; i++) {
      const r = await srv.call("wait", { tab_id: 1, seconds: 1 });
      assert.notEqual(r.isError, true);
    }
  } finally {
    await srv.close();
  }
});

test("deny mode: type with submit true is refused, submit false passes", async () => {
  const srv = await startServer({ SAFARI_MCP_DENY_RISKY: "1" });
  try {
    await srv.initialize();
    const refused = await srv.call("type", { tab_id: 1, ref: "ref_1", text: "x", submit: true });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Blocked/);
    assert.equal(srv.callsTo("/mcp/call").length, 0, "refused typing never reaches the bridge");

    const allowed = await srv.call("type", { tab_id: 1, ref: "ref_1", text: "x", submit: false });
    assert.notEqual(allowed.isError, true);
    assert.equal(srv.callsTo("/mcp/call").length, 1);
  } finally {
    await srv.close();
  }
});

test("normal mode unchanged: Enter is forwarded and risky click asks without deny", async () => {
  const srv = await startServer({});
  try {
    await srv.initialize();
    const enter = await srv.call("press_key", { tab_id: 1, key: "Enter" });
    assert.notEqual(enter.isError, true, "Enter passes without deny mode");
    assert.equal(srv.callsTo("/mcp/call").length, 1);

    const click = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.notEqual(click.isError, true);
    assert.match(click.content[0].text, /clicked/);
    const approvals = srv.callsTo("/mcp/approval");
    assert.equal(approvals.length, 1);
    assert.deepEqual(approvals[0].body, { approval_id: "a1" });
  } finally {
    await srv.close();
  }
});

test("normal mode unchanged: key allowlist, navigate allowlist and call budget are inactive without the deny switch", async () => {
  // Terminal-mode navigate is limited to the user's allowed-sites list; supply our own
  // so this test never touches the real ~/.claude-safari-bridge/allowed-sites.json.
  const sitesFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "safari-mcp-sites-")),
    "allowed-sites.json",
  );
  fs.writeFileSync(sitesFile, JSON.stringify(["example.com", "evil.com"]));
  const srv = await startServer({ SAFARI_MCP_MAX_CALLS: "2", SAFARI_SITES_FILE: sitesFile });
  try {
    await srv.initialize();
    for (const key of ["Space", "Control+Enter", "a"]) {
      const r = await srv.call("press_key", { tab_id: 1, key });
      assert.notEqual(r.isError, true, `${key} passes without deny mode`);
    }
    for (const url of ["https://example.com/", "https://evil.com/"]) {
      const r = await srv.call("navigate", { tab_id: 1, url });
      assert.notEqual(r.isError, true, `${url} passes without deny mode`);
    }
    // 5 calls so far, more than SAFARI_MCP_MAX_CALLS=2: the budget is ignored without the switch.
    const r = await srv.call("wait", { tab_id: 1, seconds: 1 });
    assert.notEqual(r.isError, true);
    assert.equal(srv.callsTo("/mcp/call").length, 6);
  } finally {
    await srv.close();
    fs.rmSync(path.dirname(sitesFile), { recursive: true, force: true });
  }
});
