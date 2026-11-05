// Tests for the approval-lost retry in bridge/safari-mcp.mjs (runToolChecked / handleApproval).
// Built-ins only. A fake bridge runs on a random port; HOME and JOBWATCH_DIR are temp paths,
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
const LOST = { error: "Approval lost (Safari restarted the extension); nothing was clicked." };

function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Fake bridge: records every request. /mcp/call answers with script.calls[n-1] (n = 1-based call number);
// /mcp/approval answers with script.approvals[approval_id]. Anything else gets a plain text answer.
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

// extraEnv adds env vars (e.g. deny-risky mode). elicitAnswers, when given, are the replies the fake client
// sends to each elicitation/create request, in order; the requests themselves are recorded in `elicitations`.
async function startServer(script, { extraEnv = {}, elicitAnswers = null } = {}) {
  const seen = [];
  const bridge = await startFakeBridge(seen, script);
  const port = bridge.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safari-mcp-retry-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".claude-safari-bridge"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude-safari-bridge", "mcp-token"), "test-token\n");
  const jobwatchDir = path.join(root, "jobwatch");

  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, HOME: home, SAFARI_BRIDGE_PORT: String(port), JOBWATCH_DIR: jobwatchDir, ...extraEnv },
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

  async function initialize(capabilities = {}) {
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

const approveTrue = (srv) => srv.callsTo("/mcp/approval").filter((r) => r.body.approve === true);
const risky = (id) => ({ needs_approval: true, approval_id: id, label: "Claude wants to Apply" });

test("approval lost once: the click is asked again and the second Allow goes through", async () => {
  const srv = await startServer({
    calls: [risky("ap-1"), risky("ap-2")],
    approvals: { "ap-1": LOST, "ap-2": { text: "Clicked" } },
  });
  try {
    await srv.initialize();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Clicked/);
    const calls = srv.callsTo("/mcp/call");
    assert.equal(calls.length, 2, "the bridge saw exactly 2 call requests");
    assert.deepEqual(calls[0].body, calls[1].body, "the retry sends the same body");
    assert.equal(srv.callsTo("/mcp/approval").length, 2);
    assert.equal(approveTrue(srv).length, 0, "no approve:true was sent without an elicitation accept");
  } finally {
    await srv.close();
  }
});

test("approval lost twice: the caller gets an error and nothing more is retried", async () => {
  const srv = await startServer({
    calls: [risky("ap-1"), risky("ap-2")],
    approvals: { "ap-1": LOST, "ap-2": LOST },
  });
  try {
    await srv.initialize();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /twice/);
    assert.match(result.content[0].text, /the action may not have been done/);
    assert.equal(approveTrue(srv).length, 0, "no approve:true was sent without an elicitation accept");
    assert.equal(srv.callsTo("/mcp/call").length, 2, "the bridge saw exactly 2 call requests");
  } finally {
    await srv.close();
  }
});

test("normal approval: no retry, exactly 1 call request", async () => {
  const srv = await startServer({
    calls: [risky("ap-1")],
    approvals: { "ap-1": { text: "Clicked" } },
  });
  try {
    await srv.initialize();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Clicked/);
    assert.equal(srv.callsTo("/mcp/call").length, 1, "the bridge saw exactly 1 call request");
    assert.equal(approveTrue(srv).length, 0, "no approve:true was sent without an elicitation accept");
  } finally {
    await srv.close();
  }
});

test("user decline is not retried: exactly 1 call request", async () => {
  const srv = await startServer({
    calls: [risky("ap-1")],
    approvals: { "ap-1": { error: "User declined: x" } },
  });
  try {
    await srv.initialize();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /User declined: x/);
    assert.equal(srv.callsTo("/mcp/call").length, 1, "the bridge saw exactly 1 call request");
    assert.equal(approveTrue(srv).length, 0, "no approve:true was sent without an elicitation accept");
  } finally {
    await srv.close();
  }
});

test("elicitation: approval lost once asks the human again and the second approve:true is sent for ap-2", async () => {
  const accept = { action: "accept", content: { allow: true } };
  const srv = await startServer(
    {
      calls: [risky("ap-1"), risky("ap-2")],
      approvals: { "ap-1": LOST, "ap-2": { text: "Clicked" } },
    },
    { elicitAnswers: [accept, accept] }
  );
  try {
    await srv.initialize({ elicitation: {} });
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Clicked/);
    assert.equal(srv.elicitations.length, 2, "the human was asked twice");
    assert.equal(srv.callsTo("/mcp/call").length, 2);
    const approvals = srv.callsTo("/mcp/approval");
    assert.equal(approvals.length, 2);
    assert.deepEqual(
      approvals.map((r) => [r.body.approval_id, r.body.approve]),
      [["ap-1", true], ["ap-2", true]]
    );
  } finally {
    await srv.close();
  }
});

test("deny-risky mode: needs_approval is declined with approve:false and /mcp/call is sent once", async () => {
  const srv = await startServer(
    {
      calls: [risky("ap-1"), risky("ap-2")],
      approvals: { "ap-1": { error: "User declined: x" }, "ap-2": { text: "Clicked" } },
    },
    { extraEnv: { SAFARI_MCP_DENY_RISKY: "1" } }
  );
  try {
    await srv.initialize();
    const result = await srv.call("click", { tab_id: 1, ref: "ref_1" });
    assert.equal(result.isError, true);
    assert.equal(srv.callsTo("/mcp/call").length, 1, "exactly 1 call request");
    const approvals = srv.callsTo("/mcp/approval");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].body.approve, false);
    assert.equal(approvals[0].body.approval_id, "ap-1");
  } finally {
    await srv.close();
  }
});
