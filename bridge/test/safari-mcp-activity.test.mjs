// Tests for the live activity feed written by bridge/safari-mcp.mjs (one line per Safari tool call).
// Built-ins only. A fake bridge runs on a random port; HOME is a temp dir, so the real token and feed are never touched.
// Fictional data only.

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

// Fake bridge: click asks for approval (label "Claude wants to Submit"); read_page returns 42 characters.
function startFakeBridge(seen) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, route: req.url, body });
      let out;
      if (req.url === "/mcp/status") {
        out = { connected: true, sharedTabs: [] };
      } else if (req.url === "/mcp/call" && body.tool === "click" && body.args.ref === "ask") {
        out = { needs_approval: true, approval_id: "a1", label: "Claude wants to Submit" };
      } else if (req.url === "/mcp/approval") {
        out = body.approve === false ? { error: "declined" } : { text: "Clicked." };
      } else if (req.url === "/mcp/call" && body.tool === "read_page") {
        out = { text: "r".repeat(42) };
      } else if (req.url === "/mcp/call" && body.tool === "click") {
        out = { text: "Clicked." };
      } else if (req.url === "/mcp/call" && body.tool === "type") {
        out = { text: "Typed into the field." };
      } else {
        out = { text: "forwarded" };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// extraEnv is merged over a minimal environment. withHome(home) may prepare the temp HOME first.
async function startServer(extraEnv = {}, prepare = () => {}) {
  const seen = [];
  const bridge = await startFakeBridge(seen);
  const port = bridge.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "safari-mcp-activity-"));
  fs.mkdirSync(path.join(home, ".claude-safari-bridge"));
  fs.writeFileSync(path.join(home, ".claude-safari-bridge", "mcp-token"), "test-token\n");
  prepare(home);

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

  const feedFile = path.join(home, ".claude-safari-bridge", "jobwatch", "activity.log");
  const feed = () => (fs.existsSync(feedFile) ? fs.readFileSync(feedFile, "utf8") : "");
  const callsTo = (route) => seen.filter((r) => r.route === route);
  return { seen, feed, feedFile, home, initialize, call, close, callsTo };
}

test("terminal source: a click writes a [terminal] line with the result", async () => {
  const srv = await startServer();
  try {
    await srv.initialize();
    const r = await srv.call("click", { tab_id: 1, ref: "ref_5" });
    assert.notEqual(r.isError, true);
    assert.match(srv.feed(), /\[terminal\] clicking ref_5 -> Clicked\./);
  } finally {
    await srv.close();
  }
});

test("watcher source: the same click writes a [watcher] line", async () => {
  const srv = await startServer({ SAFARI_MCP_SOURCE: "watcher" });
  try {
    await srv.initialize();
    await srv.call("click", { tab_id: 1, ref: "ref_5" });
    assert.match(srv.feed(), /\[watcher\] clicking ref_5 -> Clicked\./);
    assert.doesNotMatch(srv.feed(), /\[terminal\]/);
  } finally {
    await srv.close();
  }
});

test("type: the watcher line shows the text, the terminal line shows only the character count", async () => {
  const watcher = await startServer({ SAFARI_MCP_SOURCE: "watcher" });
  try {
    await watcher.initialize();
    await watcher.call("type", { tab_id: 1, ref: "ref_2", text: "hello there" });
    assert.match(watcher.feed(), /\[watcher\] typing "hello there" into ref_2/);
  } finally {
    await watcher.close();
  }

  const terminal = await startServer();
  try {
    await terminal.initialize();
    await terminal.call("type", { tab_id: 1, ref: "ref_2", text: "Test User 42" });
    assert.match(terminal.feed(), /\[terminal\] typing 12 characters into ref_2/);
    assert.doesNotMatch(terminal.feed(), /Test User 42/, "terminal privacy: the typed text is not logged");
  } finally {
    await terminal.close();
  }
});

test("safari_status writes no line to the feed", async () => {
  const srv = await startServer();
  try {
    await srv.initialize();
    const r = await srv.call("safari_status", {});
    assert.notEqual(r.isError, true);
    assert.equal(srv.callsTo("/mcp/status").length, 1);
    assert.equal(fs.existsSync(srv.feedFile), false, "no feed file is created by safari_status");
  } finally {
    await srv.close();
  }
});

test("deny mode: a refused key press is logged as blocked", async () => {
  const srv = await startServer({ SAFARI_MCP_DENY_RISKY: "1", SAFARI_MCP_SOURCE: "watcher" });
  try {
    await srv.initialize();
    const r = await srv.call("press_key", { tab_id: 1, key: "Enter" });
    assert.equal(r.isError, true);
    assert.match(srv.feed(), /\[watcher\] pressing key Enter -> blocked: the Job Watcher never submits/);
    assert.equal(srv.callsTo("/mcp/call").length, 0);
  } finally {
    await srv.close();
  }
});

test("a risky click that is waiting for the human gets a waiting line, then the outcome", async () => {
  const srv = await startServer();
  try {
    await srv.initialize();
    const r = await srv.call("click", { tab_id: 1, ref: "ask" });
    assert.notEqual(r.isError, true);
    const feed = srv.feed();
    const waiting = feed.indexOf("[terminal] waiting for your Allow in Safari: Submit");
    const done = feed.indexOf("[terminal] clicking ask -> Clicked.");
    assert.ok(waiting >= 0, `waiting line missing:\n${feed}`);
    assert.ok(done > waiting, "the outcome line comes after the waiting line");
  } finally {
    await srv.close();
  }
});

test("read_page logs the length of its result", async () => {
  const srv = await startServer();
  try {
    await srv.initialize();
    await srv.call("read_page", { tab_id: 1 });
    assert.match(srv.feed(), /\[terminal\] reading the page \(42 chars\)/);
  } finally {
    await srv.close();
  }
});

test("a logging failure never changes the tool result", async () => {
  // A file sits where the jobwatch directory should be, so the feed cannot be written.
  const srv = await startServer({}, (home) => {
    fs.writeFileSync(path.join(home, ".claude-safari-bridge", "jobwatch"), "not a directory");
  });
  try {
    await srv.initialize();
    const r = await srv.call("click", { tab_id: 1, ref: "ref_5" });
    assert.notEqual(r.isError, true);
    assert.equal(r.content[0].text, "Clicked.");
  } finally {
    await srv.close();
  }
});
