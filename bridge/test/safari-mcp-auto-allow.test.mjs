// Tests for the Easy Apply auto-allow in bridge/safari-mcp.mjs (autoAllowApply / handleApproval).
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
const FINAL_TEXT = "Easy Apply form opened";
const EASY = 'click \u201CEasy Apply to this job\u201D';
const LINKEDIN_JOB = "https://www.linkedin.com/jobs/view/1/";

function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Fake bridge: records every request. /mcp/call answers with script.calls[n-1]; /mcp/approval answers with
// script.approvals[approval_id].
function startFakeBridge(seen, script) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, route: req.url, body });
      let out;
      if (req.url === "/mcp/call") {
        const n = seen.filter((r) => r.route === "/mcp/call").length;
        out = script.calls[n - 1];
      } else if (req.url === "/mcp/approval") {
        out = script.approvals[body.approval_id];
      } else {
        out = { text: "forwarded" };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// switchFile: whether ~/.claude-safari-bridge/auto-allow-apply exists in the temp HOME.
// elicitAnswers: replies to each elicitation/create in order (default: decline).
async function startServer(script, { switchFile = false, extraEnv = {}, elicitAnswers = null, sites = ["linkedin.com"] } = {}) {
  const seen = [];
  const bridge = await startFakeBridge(seen, script);
  const port = bridge.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safari-mcp-autoallow-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".claude-safari-bridge"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude-safari-bridge", "mcp-token"), "test-token\n");
  if (switchFile) fs.writeFileSync(path.join(home, ".claude-safari-bridge", "auto-allow-apply"), "");
  const sitesFile = path.join(root, "allowed-sites.json");
  fs.writeFileSync(sitesFile, JSON.stringify(sites));
  const jobwatchDir = path.join(root, "jobwatch");

  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      SAFARI_BRIDGE_PORT: String(port),
      SAFARI_SITES_FILE: sitesFile,
      JOBWATCH_DIR: jobwatchDir,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });

  const pending = new Map();
  const elicitations = [];
  let nextId = 1;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === "elicitation/create") {
      elicitations.push(msg);
      const answer = (elicitAnswers && elicitAnswers[elicitations.length - 1]) || { action: "decline" };
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: answer })}\n`);
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

  async function initialize(capabilities = { elicitation: {} }) {
    await send("initialize", { protocolVersion: "2025-06-18", capabilities, clientInfo: { name: "test", version: "0" } });
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
    fs.rmSync(root, { recursive: true, force: true });
  }

  const callsTo = (route) => seen.filter((r) => r.route === route);
  return { seen, elicitations, initialize, call, close, callsTo };
}

// A risky action as the bridge reports it, on the given page.
const risky = (id, label, tabUrl = LINKEDIN_JOB) => ({
  needs_approval: true,
  approval_id: id,
  label: `Claude wants to ${label}`,
  tab_url: tabUrl,
  tab_title: "Job",
});
const OK = (id) => ({ text: FINAL_TEXT, id });

test("switch file present, Easy Apply on LinkedIn: auto-allowed without asking the human", async () => {
  const srv = await startServer(
    { calls: [risky("ap-1", EASY)], approvals: { "ap-1": OK("ap-1") } },
    { switchFile: true }
  );
  try {
    await srv.initialize();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Easy Apply form opened/);
    assert.equal(srv.elicitations.length, 0, "no elicitation/create was sent");
    const approvals = srv.callsTo("/mcp/approval");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].body.approve, true);
    assert.equal(approvals[0].body.approval_id, "ap-1");
  } finally {
    await srv.close();
  }
});

test("switch file absent: the same Easy Apply click goes to the human and is declined", async () => {
  const srv = await startServer({ calls: [risky("ap-1", EASY)], approvals: { "ap-1": { text: "x" } } }, { switchFile: false });
  try {
    await srv.initialize();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /User declined/);
    assert.equal(srv.elicitations.length, 1, "the human was asked");
    const approvals = srv.callsTo("/mcp/approval");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].body.approve, false);
  } finally {
    await srv.close();
  }
});

test("switch file present, Submit application: not auto-allowed, human declines", async () => {
  const srv = await startServer(
    { calls: [risky("ap-1", 'click \u201CSubmit application\u201D')], approvals: { "ap-1": { text: "x" } } },
    { switchFile: true }
  );
  try {
    await srv.initialize();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /User declined/);
    assert.equal(srv.elicitations.length, 1);
    assert.equal(srv.callsTo("/mcp/approval")[0].body.approve, false);
  } finally {
    await srv.close();
  }
});

test("switch file present, Apply on company website and plain Apply: not auto-allowed", async () => {
  for (const label of ['click \u201CApply on company website\u201D', 'click \u201CApply\u201D']) {
    const srv = await startServer(
      { calls: [risky("ap-1", label)], approvals: { "ap-1": { text: "x" } } },
      { switchFile: true }
    );
    try {
      await srv.initialize();
      const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
      assert.equal(result.isError, true, label);
      assert.match(result.content[0].text, /User declined/, label);
      assert.equal(srv.elicitations.length, 1, label);
      assert.equal(srv.callsTo("/mcp/approval")[0].body.approve, false, label);
    } finally {
      await srv.close();
    }
  }
});

test("switch file present, Easy Apply on a site not on the allowed list: not auto-allowed", async () => {
  const srv = await startServer(
    { calls: [risky("ap-1", EASY, "https://example.org/x")], approvals: { "ap-1": { text: "x" } } },
    { switchFile: true }
  );
  try {
    await srv.initialize();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /User declined/);
    assert.equal(srv.elicitations.length, 1);
    assert.equal(srv.callsTo("/mcp/approval")[0].body.approve, false);
  } finally {
    await srv.close();
  }
});

test("deny-risky mode with the switch file present: approve is never true", async () => {
  const srv = await startServer(
    { calls: [risky("ap-1", EASY)], approvals: { "ap-1": { text: "x" } } },
    { switchFile: true, extraEnv: { SAFARI_MCP_DENY_RISKY: "1" } }
  );
  try {
    await srv.initialize();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.equal(result.isError, true);
    const approvals = srv.callsTo("/mcp/approval");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].body.approve, false);
    assert.equal(srv.callsTo("/mcp/approval").filter((r) => r.body.approve === true).length, 0);
    assert.equal(srv.elicitations.length, 0);
  } finally {
    await srv.close();
  }
});

test("cap: 10 auto-allows in one process succeed, the 11th goes to the human", async () => {
  const calls = [];
  const approvals = {};
  for (let i = 1; i <= 11; i++) {
    calls.push(risky(`ap-${i}`, EASY));
    approvals[`ap-${i}`] = OK(`ap-${i}`);
  }
  const srv = await startServer({ calls, approvals }, { switchFile: true });
  try {
    await srv.initialize();
    for (let i = 1; i <= 10; i++) {
      const result = await srv.call("click", { tab_id: 1, ref: `ref_${i}` });
      assert.notEqual(result.isError, true, `auto-allow ${i}`);
    }
    assert.equal(srv.elicitations.length, 0, "the first 10 asked nobody");
    const eleventh = await srv.call("click", { tab_id: 1, ref: "ref_11" });
    assert.equal(eleventh.isError, true);
    assert.match(eleventh.content[0].text, /User declined/);
    assert.equal(srv.elicitations.length, 1, "the 11th was put to the human");
    const last = srv.callsTo("/mcp/approval").at(-1);
    assert.equal(last.body.approval_id, "ap-11");
    assert.equal(last.body.approve, false);
  } finally {
    await srv.close();
  }
});
