// Tests for bridge/assistant-mcp.mjs (the terminal-session assistant MCP server).
// Built-ins only. Every path lives in a temp HOME; a fake osascript (never the real one) records its argv.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assistant-mcp.mjs");
const CALL_TIMEOUT_MS = 10_000;
const PHONE = "+971-50-000-0000";

function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Writes a fake osascript: records each argv item on its own line in argvFile, then exits with exitCode.
function writeFakeOsascript(dir, name, argvFile, exitCode) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${argvFile}'\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return file;
}

// Writes a fake jobwatch command: records each argv item on its own line in argvFile and echoes its arguments.
function writeFakeJobwatch(dir, argvFile) {
  const file = path.join(dir, "fake-jobwatch");
  fs.writeFileSync(
    file,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${argvFile}'\necho "fake jobwatch: $*"\nexit 0\n`,
    { mode: 0o755 },
  );
  return file;
}

// Starts the server with a temp HOME and JOBWATCH_DIR. Returns helpers and the temp paths.
async function startAssistant({ profileMd, extraEnv = {}, fakeExit = 0, setup, testMode = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-mcp-"));
  const jobDir = path.join(home, "jobwatch");
  fs.mkdirSync(jobDir, { recursive: true });
  const profileFile = path.join(home, "profile.md");
  if (profileMd !== undefined) fs.writeFileSync(profileFile, profileMd);
  const argvFile = path.join(home, "osascript-argv.txt");
  const fake = writeFakeOsascript(home, "fake-osascript", argvFile, fakeExit);
  const jobwatchArgv = path.join(home, "jobwatch-argv.txt");
  const fakeJobwatch = writeFakeJobwatch(home, jobwatchArgv);
  const fitFile = path.join(home, "fit-log.json");
  if (setup) setup({ jobDir, home });

  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      JOBWATCH_DIR: jobDir,
      ASSISTANT_PROFILE_FILE: profileFile,
      ASSISTANT_OSASCRIPT: fake,
      JOBWATCH_CMD: fakeJobwatch,
      FIT_LOG_FILE: fitFile,
      ...(testMode ? { ASSISTANT_TEST_MODE: "1" } : {}),
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
    const p = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return withTimeout(p, CALL_TIMEOUT_MS, method);
  }

  async function call(name, args) {
    const msg = await send("tools/call", { name, arguments: args });
    return msg;
  }

  function close() {
    child.stdin.end();
    child.kill();
    rl.close();
  }

  const readFile = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  const activity = () => readFile(path.join(jobDir, "activity.log"));
  const fitEntries = () => {
    const t = readFile(fitFile);
    return t ? JSON.parse(t) : [];
  };
  return { send, call, close, home, jobDir, profileFile, argvFile, jobwatchArgv, activity, readFile, fitFile, fitEntries };
}

const PROFILE_MD = [
  "# Profile",
  "",
  "## Contact",
  "Test User, test@example.com",
  "",
  "## Salary",
  "Expected 00000 AED per month",
  "",
].join("\n");

function resultText(msg) {
  return msg.result.content.map((p) => p.text).join("\n");
}

test("tools/list exposes exactly the fifteen assistant tools", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const init = await a.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(init.result.serverInfo.name, "assistant");
    const list = await a.send("tools/list", {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [
      "fit_list",
      "fit_lookup",
      "fit_record",
      "notify_ready",
      "profile_lookup",
      "queue_mark",
      "ready_list",
      "recent_activity",
      "resume_build",
      "resume_read",
      "resume_status",
      "site_note",
      "site_notes",
      "site_request",
      "watcher_control",
    ]);
    for (const t of list.result.tools) assert.equal(t.inputSchema.additionalProperties, false);
  } finally {
    a.close();
  }
});

test("profile_lookup returns only the matching section and logs the count, not the text", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("profile_lookup", { query: "salary" });
    const text = resultText(r);
    assert.match(text, /## Salary/);
    assert.match(text, /Expected 00000 AED/);
    assert.doesNotMatch(text, /Test User/);
    assert.doesNotMatch(text, /test@example\.com/);
    const log = a.activity();
    assert.match(log, /\[terminal\] profile lookup \(1 sections\)/);
    assert.doesNotMatch(log, /Expected 00000/);
    assert.doesNotMatch(log, /salary/i);
  } finally {
    a.close();
  }
});

test("profile_lookup with an empty query returns headings only, never bodies", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("profile_lookup", { query: "   " });
    const text = resultText(r);
    assert.match(text, /Contact/);
    assert.match(text, /Salary/);
    assert.doesNotMatch(text, /Test User/);
    assert.doesNotMatch(text, /Expected 00000/);
    assert.doesNotMatch(text, /# Profile/);
  } finally {
    a.close();
  }
});

test("profile_lookup with a missing or empty profile file asks the user to run profile-md", async () => {
  const missing = await startAssistant({});
  try {
    const r = await missing.call("profile_lookup", { query: "salary" });
    assert.match(resultText(r), /No profile\.md yet\. Ask the user to run: node bridge\/jobwatch\.mjs profile-md/);
  } finally {
    missing.close();
  }
  const empty = await startAssistant({ profileMd: "" });
  try {
    const r = await empty.call("profile_lookup", { query: "salary" });
    assert.match(resultText(r), /No profile\.md yet/);
  } finally {
    empty.close();
  }
});

test("profile_lookup rejects a non-string query with an error result, not a crash", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("profile_lookup", { query: 42 });
    assert.equal(r.result.isError, true);
    const again = await a.send("ping", {});
    assert.deepEqual(again.result, {});
  } finally {
    a.close();
  }
});

test("watcher source gets an empty tool list and every call is refused", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: { SAFARI_MCP_SOURCE: "watcher" } });
  try {
    const list = await a.send("tools/list", {});
    assert.deepEqual(list.result.tools, []);
    const r = await a.call("profile_lookup", { query: "salary" });
    assert.ok(r.error || r.result?.isError, "expected an error for a watcher call");
    const n = await a.call("notify_ready", { title: "Form ready" });
    assert.ok(n.error || n.result?.isError, "expected an error for a watcher alert");
    assert.equal(fs.existsSync(a.argvFile), false, "watcher must never run osascript");
    assert.equal(a.activity(), "", "watcher must never write the activity feed");
  } finally {
    a.close();
  }
});

test("notify_ready falls back to the generic title when the text holds the profile phone", async () => {
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ jobDir }) => fs.writeFileSync(path.join(jobDir, "profile.json"), JSON.stringify({ phone: PHONE, name: "Test User" })),
  });
  try {
    const r = await a.call("notify_ready", { title: `Call ${PHONE} now`, detail: "Form filled", needs_you: ["Review the form"] });
    const text = resultText(r);
    assert.match(text, /Alert sent \(Mac: ok, iPhone Reminder: ok\)\./);
    assert.match(text, /The text contained personal details, so the generic line was sent instead\./);
    const argv = a.readFile(a.argvFile);
    assert.match(argv, /Form ready for your review/);
    assert.doesNotMatch(argv, /971-50/);
    assert.match(a.activity(), /\[terminal\] ready alert sent: Form ready for your review/);
    assert.doesNotMatch(a.activity(), /971-50/);
  } finally {
    a.close();
  }
});

test("notify_ready still returns a result when osascript fails", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD, fakeExit: 1 });
  try {
    const r = await a.call("notify_ready", { title: "Form ready", detail: "Review it" });
    assert.equal(r.result.isError, undefined);
    assert.match(resultText(r), /Alert sent \(Mac: failed, iPhone Reminder: failed\)\./);
    const again = await a.call("ready_list", {});
    assert.equal(again.result.isError, undefined);
  } finally {
    a.close();
  }
});

test("recent_activity clamps lines to 200", async () => {
  const lines = Array.from({ length: 250 }, (_, i) => `2026-11-04 line ${i + 1}`);
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ jobDir }) => fs.writeFileSync(path.join(jobDir, "activity.log"), lines.join("\n") + "\n"),
  });
  try {
    const r = await a.call("recent_activity", { lines: 9999 });
    const text = resultText(r);
    const out = text.split("\n").filter(Boolean);
    assert.equal(out.length, 200);
    assert.match(text, /line 250$/m);
    assert.doesNotMatch(text, /line 50$/m);
  } finally {
    a.close();
  }
});

test("ready_list lists a queued Ready item and omits a done one", async () => {
  const queue = [
    {
      id: "j1",
      title: "Test Role",
      company: "Test Co",
      location: "Dubai",
      url: "https://www.linkedin.com/jobs/view/1",
      status: "discovered",
    },
    { id: "j2", title: "Old Role", company: "Old Co", location: "Abu Dhabi", url: "https://www.linkedin.com/jobs/view/2", status: "done" },
  ];
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ jobDir }) => fs.writeFileSync(path.join(jobDir, "queue.json"), JSON.stringify(queue)),
  });
  try {
    const r = await a.call("ready_list", {});
    const text = resultText(r);
    assert.match(text, /^j1 — Test Role — Test Co — Dubai — https:\/\/www\.linkedin\.com\/jobs\/view\/1 — discovered/m);
    assert.doesNotMatch(text, /Old Role/);
    assert.match(a.activity(), /\[terminal\] read the Ready list/);
  } finally {
    a.close();
  }
});

test("ready_list on an empty queue says so", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("ready_list", {});
    assert.equal(resultText(r), "The Ready list is empty.");
  } finally {
    a.close();
  }
});

const QUEUE_MARK_FIXTURE = [
  {
    id: "j1",
    title: "Test Role",
    company: "Test Co",
    location: "Dubai",
    url: "https://www.linkedin.com/jobs/view/1",
    status: "discovered",
  },
  {
    id: "j2",
    title: "Test Role",
    company: "Test Co",
    location: "Dubai",
    url: "https://www.linkedin.com/jobs/view/2",
    status: "discovered",
  },
];

test("queue_mark with a known id and done changes the stored status", async () => {
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ jobDir }) => fs.writeFileSync(path.join(jobDir, "queue.json"), JSON.stringify(QUEUE_MARK_FIXTURE)),
  });
  try {
    const r = await a.call("queue_mark", { id: "j2", status: "done" });
    assert.equal(resultText(r), "Marked j2 as done.");
    const stored = JSON.parse(a.readFile(path.join(a.jobDir, "queue.json")));
    assert.equal(stored.find((i) => i.id === "j2").status, "done");
    assert.equal(stored.find((i) => i.id === "j1").status, "discovered");
    assert.match(a.activity(), /\[terminal\]/);
  } finally {
    a.close();
  }
});

test("queue_mark with an unknown id is refused and queue.json is unchanged", async () => {
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ jobDir }) => fs.writeFileSync(path.join(jobDir, "queue.json"), JSON.stringify(QUEUE_MARK_FIXTURE)),
  });
  try {
    const before = a.readFile(path.join(a.jobDir, "queue.json"));
    const r = await a.call("queue_mark", { id: "nope", status: "done" });
    assert.equal(resultText(r), "Unknown job id.");
    assert.equal(a.readFile(path.join(a.jobDir, "queue.json")), before);
  } finally {
    a.close();
  }
});

test("queue_mark refuses status discovered and queue.json is unchanged", async () => {
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ jobDir }) => fs.writeFileSync(path.join(jobDir, "queue.json"), JSON.stringify(QUEUE_MARK_FIXTURE)),
  });
  try {
    const before = a.readFile(path.join(a.jobDir, "queue.json"));
    const r = await a.call("queue_mark", { id: "j1", status: "discovered" });
    assert.equal(resultText(r), "Status must be done, skipped or prepare.");
    assert.equal(a.readFile(path.join(a.jobDir, "queue.json")), before);
  } finally {
    a.close();
  }
});

test("an unknown tool is an error result, not a crash", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("share_all", {});
    assert.ok(r.error || r.result?.isError);
    const again = await a.send("ping", {});
    assert.deepEqual(again.result, {});
  } finally {
    a.close();
  }
});

test("notify_ready fails closed with the generic title when profile.json is missing", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("notify_ready", { title: "Call Somebody Private", detail: "Form filled" });
    const text = resultText(r);
    assert.match(text, /The profile could not be checked, so the generic line was sent instead\./);
    const argv = a.readFile(a.argvFile);
    assert.match(argv, /Form ready for your review/);
    assert.doesNotMatch(argv, /Somebody Private/);
  } finally {
    a.close();
  }
});

test("notify_ready never renames or rewrites a corrupt profile.json", async () => {
  const CORRUPT = "{ not json";
  let corruptPath;
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ jobDir }) => {
      corruptPath = path.join(jobDir, "profile.json");
      fs.writeFileSync(corruptPath, CORRUPT);
    },
  });
  try {
    const r = await a.call("notify_ready", { title: "Form ready" });
    assert.match(resultText(r), /profile could not be checked/);
    assert.equal(fs.readFileSync(corruptPath, "utf8"), CORRUPT);
    assert.deepEqual(fs.readdirSync(path.dirname(corruptPath)).filter((f) => f.startsWith("profile.json")), ["profile.json"]);
  } finally {
    a.close();
  }
});

test("watcher_control is listed for the terminal server", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const list = await a.send("tools/list", {});
    const tool = list.result.tools.find((t) => t.name === "watcher_control");
    assert.ok(tool, "watcher_control must be listed");
    assert.equal(tool.inputSchema.additionalProperties, false);
  } finally {
    a.close();
  }
});

test("watcher_control status runs jobwatch status and returns its output", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("watcher_control", { action: "status" });
    assert.equal(r.result.isError, undefined);
    assert.match(resultText(r), /fake jobwatch: status/);
    assert.equal(a.readFile(a.jobwatchArgv), "status\n");
  } finally {
    a.close();
  }
});

test("watcher_control pause with hours 2 runs jobwatch pause 2", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("watcher_control", { action: "pause", hours: 2 });
    assert.equal(r.result.isError, undefined);
    assert.equal(a.readFile(a.jobwatchArgv), "pause\n2\n");
  } finally {
    a.close();
  }
});

test("watcher_control resume runs jobwatch resume", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("watcher_control", { action: "resume" });
    assert.equal(r.result.isError, undefined);
    assert.equal(a.readFile(a.jobwatchArgv), "resume\n");
  } finally {
    a.close();
  }
});

const NOT_AVAILABLE_TEXT = "Not available. The Recruiter runs every 10 minutes; use status, pause or resume.";

test("watcher_control run_now is refused with the exact text and jobwatch is not run", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("watcher_control", { action: "run_now" });
    assert.equal(r.result.isError, undefined);
    assert.equal(resultText(r), NOT_AVAILABLE_TEXT);
    assert.equal(fs.existsSync(a.jobwatchArgv), false, "jobwatch must not run for run_now");
  } finally {
    a.close();
  }
});

test("watcher_control set_interval is refused with the exact text and jobwatch is not run", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("watcher_control", { action: "set_interval", minutes: 10 });
    assert.equal(r.result.isError, undefined);
    assert.equal(resultText(r), NOT_AVAILABLE_TEXT);
    assert.equal(fs.existsSync(a.jobwatchArgv), false, "jobwatch must not run for set_interval");
  } finally {
    a.close();
  }
});

test("watcher_control set_interval without minutes is refused the same way", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("watcher_control", { action: "set_interval" });
    assert.equal(resultText(r), NOT_AVAILABLE_TEXT);
    assert.equal(fs.existsSync(a.jobwatchArgv), false, "jobwatch must not run for set_interval");
  } finally {
    a.close();
  }
});

test("watcher_control refuses an unknown action and never runs jobwatch", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("watcher_control", { action: "status; rm -rf ~" });
    assert.equal(r.result.isError, true);
    assert.equal(fs.existsSync(a.jobwatchArgv), false);
  } finally {
    a.close();
  }
});

test("watcher_control starts jobwatch with an argument array, never a shell string", async () => {
  const src = fs.readFileSync(SERVER, "utf8");
  assert.doesNotMatch(src, /\bexec\(/);
  assert.doesNotMatch(src, /shell:\s*true/);
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    await a.call("watcher_control", { action: "status" });
    assert.equal(a.readFile(a.jobwatchArgv), "status\n", "each argument must arrive as its own argv item");
  } finally {
    a.close();
  }
});

test("JOBWATCH_CMD is ignored without ASSISTANT_TEST_MODE, so watcher_control runs jobwatch.mjs", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD, testMode: false });
  try {
    await a.call("watcher_control", { action: "status" });
    assert.equal(a.readFile(a.jobwatchArgv), "", "the JOBWATCH_CMD executable must not be run");
  } finally {
    a.close();
  }
});

// ---------- fit judgments (fit_record, fit_lookup, and the ready_list verdict) ----------

const FIT_JOB_URL = "https://www.linkedin.com/jobs/view/1";
const FIT_ARGS = {
  job_url: FIT_JOB_URL,
  title: "Test Role",
  company: "Test Co",
  verdict: "strong",
  score: 82,
  reasons: ["Role matches the target", "Location matches"],
  gaps: ["Excel"],
};

test("fit_record with valid arguments stores the fit", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("fit_record", FIT_ARGS);
    assert.notEqual(r.result.isError, true, resultText(r));
    const entries = a.fitEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].job_url, FIT_JOB_URL);
    assert.equal(entries[0].verdict, "strong");
    assert.equal(entries[0].score, 82);
    assert.match(entries[0].rules_hash, /^[0-9a-f]{64}$/);
  } finally {
    a.close();
  }
});

test("fit_record with an invalid verdict returns error text and stores nothing", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("fit_record", { ...FIT_ARGS, verdict: "maybe" });
    assert.equal(r.result.isError, true);
    assert.match(resultText(r), /verdict must be strong, stretch or no/);
    assert.deepEqual(a.fitEntries(), []);
  } finally {
    a.close();
  }
});

test("fit_record with score 101 is refused and stores nothing", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("fit_record", { ...FIT_ARGS, score: 101 });
    assert.equal(r.result.isError, true);
    assert.match(resultText(r), /score must be an integer from 0 to 100/);
    assert.deepEqual(a.fitEntries(), []);
  } finally {
    a.close();
  }
});

test("fit_lookup of an unknown url says none", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    const r = await a.call("fit_lookup", { job_url: "https://www.linkedin.com/jobs/view/999" });
    assert.equal(resultText(r), "none");
  } finally {
    a.close();
  }
});

test("fit_lookup after a store returns the verdict and score", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    await a.call("fit_record", FIT_ARGS);
    const r = await a.call("fit_lookup", { job_url: FIT_JOB_URL });
    assert.equal(resultText(r), "strong 82");
  } finally {
    a.close();
  }
});

test("fit_lookup says none when the stored fit was judged under other rules", async () => {
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ home }) => {
      const stale = [{ ...FIT_ARGS, rules_hash: "stale", recorded_at: "2026-11-01T00:00:00.000Z" }];
      fs.writeFileSync(path.join(home, "fit-log.json"), JSON.stringify(stale));
    },
  });
  try {
    const r = await a.call("fit_lookup", { job_url: FIT_JOB_URL });
    assert.equal(resultText(r), "none");
  } finally {
    a.close();
  }
});

test("ready_list shows the verdict for a job with a fit and leaves other lines unchanged", async () => {
  const queue = [
    { id: "j1", title: "Test Role", company: "Test Co", location: "Dubai", url: FIT_JOB_URL, status: "discovered" },
    {
      id: "j2",
      title: "Other Role",
      company: "Other Co",
      location: "Dubai",
      url: "https://www.linkedin.com/jobs/view/2",
      status: "discovered",
    },
  ];
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ jobDir }) => fs.writeFileSync(path.join(jobDir, "queue.json"), JSON.stringify(queue)),
  });
  try {
    await a.call("fit_record", FIT_ARGS);
    const text = resultText(await a.call("ready_list", {}));
    assert.match(text, /^j1 — Test Role — Test Co — Dubai — https:\/\/www\.linkedin\.com\/jobs\/view\/1 — discovered \| fit: strong 82$/m);
    assert.match(text, /^j2 — Other Role — Other Co — Dubai — https:\/\/www\.linkedin\.com\/jobs\/view\/2 — discovered$/m);
  } finally {
    a.close();
  }
});

// ---------- fit_list ----------

function fitAt(n, overrides = {}) {
  return {
    job_url: `https://www.linkedin.com/jobs/view/${n}`,
    title: `Role ${n}`,
    company: `Co ${n}`,
    verdict: "stretch",
    score: 50 + n,
    reasons: [`Reason ${n} first`, "Second"],
    gaps: ["A", "B"],
    ...overrides,
  };
}

test("fit_list on an empty store says so", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    assert.equal(resultText(await a.call("fit_list", {})), "No stored fits.");
    assert.equal(resultText(await a.call("fit_list", { verdict: "stretch" })), "No stored stretch fits.");
  } finally {
    a.close();
  }
});

test("fit_list numbers entries newest first, filters by verdict and shows stored fields only", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD });
  try {
    await a.call("fit_record", fitAt(1));
    await a.call("fit_record", fitAt(2, { verdict: "strong" }));
    await a.call("fit_record", fitAt(3));
    const all = resultText(await a.call("fit_list", {})).split("\n");
    assert.equal(all.length, 3);
    assert.match(all[0], /^1\. Role 3 — Co 3 — stretch 53 — https:\/\/www\.linkedin\.com\/jobs\/view\/3 — reason: Reason 3 first — gaps: 2$/);
    assert.match(all[2], /^3\. Role 1 /);
    const stretch = resultText(await a.call("fit_list", { verdict: "stretch" })).split("\n");
    assert.equal(stretch.length, 2);
    assert.match(stretch[0], /^1\. Role 3 /);
    assert.match(stretch[1], /^2\. Role 1 /);
    assert.ok(!stretch.join("\n").includes("Role 2"));
  } finally {
    a.close();
  }
});

test("fit_list marks an entry judged under other rules as stale", async () => {
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ home }) => {
      const old = [{ ...fitAt(9), rules_hash: "old", recorded_at: "2026-11-01T00:00:00.000Z" }];
      fs.writeFileSync(path.join(home, "fit-log.json"), JSON.stringify(old));
    },
  });
  try {
    const stale = resultText(await a.call("fit_list", {}));
    assert.match(stale, /stale/);
    await a.call("fit_record", fitAt(9));
    assert.doesNotMatch(resultText(await a.call("fit_list", {})), /stale/);
  } finally {
    a.close();
  }
});

test("fit_list caps limit at 50 and honours a smaller limit", async () => {
  const many = Array.from({ length: 55 }, (_, i) => ({
    ...fitAt(i + 1),
    rules_hash: "x",
    recorded_at: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
  }));
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    setup: ({ home }) => fs.writeFileSync(path.join(home, "fit-log.json"), JSON.stringify(many)),
  });
  try {
    const def = resultText(await a.call("fit_list", {})).split("\n");
    assert.equal(def.length, 21, "20 entries plus the more-line");
    const big = resultText(await a.call("fit_list", { limit: 500 })).split("\n");
    assert.equal(big.filter((l) => /^\d+\. /.test(l)).length, 50);
    const two = resultText(await a.call("fit_list", { limit: 2 })).split("\n");
    assert.equal(two.filter((l) => /^\d+\. /.test(l)).length, 2);
    assert.match(two[0], /^1\. Role 55 /);
  } finally {
    a.close();
  }
});

test("site_request for a host already pending does not alert again", async () => {
  const env = siteEnvFor();
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    extraEnv: { ...env },
    setup: ({ jobDir }) => fs.writeFileSync(path.join(jobDir, "profile.json"), "{}"),
  });
  try {
    const args = { host: "careers.example.org", country: "AE", reason: "Good listings" };
    const first = await a.call("site_request", args);
    assert.match(resultText(first), /pending/i);
    assert.match(a.readFile(a.argvFile), /Site approval needed/);
    fs.rmSync(a.argvFile);
    const second = await a.call("site_request", args);
    assert.equal(resultText(second), resultText(first));
    assert.equal(fs.existsSync(a.argvFile), false, "no second alert for a pending host");
    assert.equal(JSON.parse(a.readFile(env.SITE_SCOUT_FILE)).pending.length, 1);
  } finally {
    a.close();
  }
});

// Site scout tools: a temp scout file and a temp allowed-sites file. Never the real files.
test("site_note stores a note and site_notes returns it for the country", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: { ...siteEnvFor() } });
  try {
    const n = await a.call("site_note", { host: "jobs.example.com", country: "AE", quality: 4, notes: "Good filters" });
    assert.match(resultText(n), /saved/i);
    const list = await a.call("site_notes", { country: "AE" });
    assert.match(resultText(list), /jobs\.example\.com/);
    assert.match(resultText(list), /Good filters/);
    const none = await a.call("site_notes", { country: "SG" });
    assert.match(resultText(none), /No notes/);
  } finally {
    a.close();
  }
});

test("site_note refuses a bad quality with an error result", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: { ...siteEnvFor() } });
  try {
    const r = await a.call("site_note", { host: "jobs.example.com", country: "AE", quality: 9, notes: "x" });
    assert.ok(r.result?.isError, "expected an error result");
    assert.match(resultText(r), /quality/);
  } finally {
    a.close();
  }
});

test("site_request says already-allowed for a host under an allowed site and sends no alert", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: { ...siteEnvFor() } });
  try {
    const r = await a.call("site_request", { host: "jobs.example.com", country: "AE", reason: "Listings" });
    assert.match(resultText(r), /already allowed/i);
    assert.equal(fs.existsSync(a.argvFile), false, "no alert for an allowed host");
  } finally {
    a.close();
  }
});

test("site_request for a new host records it pending and sends a generic alert with no host", async () => {
  // An empty profile.json lets the title through; without it notify fails closed to the generic title.
  const env = siteEnvFor();
  const a = await startAssistant({
    profileMd: PROFILE_MD,
    extraEnv: { ...env },
    setup: ({ jobDir }) => fs.writeFileSync(path.join(jobDir, "profile.json"), "{}"),
  });
  try {
    const r = await a.call("site_request", { host: "careers.example.org", country: "AE", reason: "Good listings" });
    assert.match(resultText(r), /pending/i);
    const alert = a.readFile(a.argvFile);
    assert.match(alert, /Site approval needed/);
    assert.doesNotMatch(alert, /careers\.example\.org/);
    const scout = JSON.parse(a.readFile(env.SITE_SCOUT_FILE));
    assert.equal(scout.pending.length, 1);
    assert.equal(scout.pending[0].host, "careers.example.org");
  } finally {
    a.close();
  }
});

test("site_request refuses a bank-like host and sends no alert", async () => {
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: { ...siteEnvFor() } });
  try {
    const r = await a.call("site_request", { host: "bank.example.net", country: "AE", reason: "Jobs" });
    assert.ok(r.result?.isError, "expected an error result");
    assert.equal(fs.existsSync(a.argvFile), false);
  } finally {
    a.close();
  }
});

// Scout env for startAssistant: the helper creates the temp HOME, so the files are placed in a per-test dir.
function siteEnvFor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-tools-"));
  fs.writeFileSync(path.join(dir, "allowed-sites.json"), JSON.stringify(["example.com"]));
  return {
    SITE_SCOUT_FILE: path.join(dir, "site-scout.json"),
    SAFARI_SITES_FILE: path.join(dir, "allowed-sites.json"),
  };
}

// ---------- resume tools (fictional data only; RESUME_DIR is a temp dir) ----------

const RESUME_MASTER = [
  "Test Person",
  "test.person@example.com",
  "",
  "Summary",
  "Analyst who builds monthly reporting packs.",
  "",
  "Experience",
  "Analyst, Example Co, 2020 to 2024",
  "Built monthly reporting packs in Excel for the finance team.",
  "",
  "Education",
  "BSc Statistics, Example University",
  "",
].join("\n");

// A per-test resume folder. With master set, writes master.txt into it.
function resumeEnvFor({ withMaster = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-tools-"));
  if (withMaster) fs.writeFileSync(path.join(dir, "master.txt"), RESUME_MASTER);
  return { dir, env: { RESUME_DIR: dir } };
}

function resumeInput(bullets) {
  return {
    header: { name: "Test Person", contact: "test.person@example.com" },
    job_title: "Reporting Analyst",
    company: "Example Co",
    summary: "Analyst who builds monthly reporting packs.",
    skills: ["Excel"],
    experience: [{ role: "Analyst", company: "Example Co", dates: "2020 to 2024", bullets }],
    education: [{ text: "BSc Statistics, Example University", source: "BSc Statistics, Example University" }],
    keywords_used: ["Excel"],
    job_keywords: ["Excel", "Python"],
  };
}

const GOOD_BULLET = {
  text: "Built monthly reporting packs in Excel",
  source: "Built monthly reporting packs in Excel for the finance team.",
};

test("resume_status with no master says missing and reads nothing", async () => {
  const r0 = resumeEnvFor();
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const r = await a.call("resume_status", {});
    assert.equal(resultText(r), "master resume: missing");
  } finally {
    a.close();
  }
});

test("resume_status with a master.txt says present (txt) and never shows its name", async () => {
  const r0 = resumeEnvFor({ withMaster: true });
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const r = await a.call("resume_status", {});
    assert.equal(resultText(r), "master resume: present (txt), readable: yes");
    assert.equal(resultText(r).includes("Test Person"), false);
  } finally {
    a.close();
  }
});

test("resume_read with no master says missing and is not an error", async () => {
  const r0 = resumeEnvFor();
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const r = await a.call("resume_read", {});
    assert.notEqual(r.result?.isError, true);
    assert.match(resultText(r), /missing/);
    assert.match(resultText(r), /Word or text copy/);
  } finally {
    a.close();
  }
});

test("resume_read with a master.txt returns that text", async () => {
  const r0 = resumeEnvFor({ withMaster: true });
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const r = await a.call("resume_read", {});
    assert.notEqual(r.result?.isError, true);
    assert.equal(resultText(r), RESUME_MASTER);
  } finally {
    a.close();
  }
});

test("resume_read cuts a master longer than 20000 characters with a note", async () => {
  const r0 = resumeEnvFor();
  fs.writeFileSync(path.join(r0.dir, "master.txt"), "Analyst line for testing. ".repeat(1000));
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const r = await a.call("resume_read", {});
    const text = resultText(r);
    assert.ok(text.startsWith("Analyst line for testing."));
    assert.ok(text.endsWith("\ntext cut at 20000 characters"));
    assert.equal(text.length, 20000 + "\ntext cut at 20000 characters".length);
  } finally {
    a.close();
  }
});

test("resume_build with no master is refused and creates no out directory", async () => {
  const r0 = resumeEnvFor();
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const r = await a.call("resume_build", resumeInput([GOOD_BULLET]));
    assert.equal(r.result?.isError, true);
    assert.match(resultText(r), /missing/);
    assert.equal(fs.existsSync(path.join(r0.dir, "out")), false);
  } finally {
    a.close();
  }
});

test("resume_build with a valid fictional input returns the docx path and the gaps", async () => {
  const r0 = resumeEnvFor({ withMaster: true });
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const r = await a.call("resume_build", resumeInput([GOOD_BULLET]));
    assert.equal(r.result?.isError, undefined);
    const text = resultText(r);
    assert.ok(text.includes(".docx"), text);
    assert.ok(text.includes(r0.dir), text);
    assert.ok(text.includes("job keywords not in your resume: Python"), text);
  } finally {
    a.close();
  }
});

test("resume_build with a bullet that adds a number is refused, writes nothing, and never echoes the contact", async () => {
  const r0 = resumeEnvFor({ withMaster: true });
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const bad = {
      text: "Built monthly reporting packs in Excel for 5 teams",
      source: "Built monthly reporting packs in Excel for the finance team.",
    };
    const r = await a.call("resume_build", resumeInput([bad]));
    assert.equal(r.result?.isError, true);
    assert.equal(fs.existsSync(path.join(r0.dir, "out")), false);
    assert.equal(resultText(r).includes("test.person@example.com"), false);
    assert.equal(resultText(r).includes("Built monthly reporting packs in Excel for 5 teams"), false);
  } finally {
    a.close();
  }
});

test("resume_build refuses a phone number placed in skills or the summary without echoing it", async () => {
  const r0 = resumeEnvFor({ withMaster: true });
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const input = resumeInput([GOOD_BULLET]);
    input.skills = ["+971 50 123 4567"];
    input.summary = "Call +971 50 123 4567 for builds.";
    const r = await a.call("resume_build", input);
    assert.equal(r.result?.isError, true);
    assert.equal(/971|4567/.test(resultText(r)), false, resultText(r));
    assert.equal(fs.existsSync(path.join(r0.dir, "out")), false);
  } finally {
    a.close();
  }
});

test("resume_build rejects a non-object bullet instead of throwing", async () => {
  const r0 = resumeEnvFor({ withMaster: true });
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const r = await a.call("resume_build", resumeInput([null]));
    assert.equal(r.result?.isError, true);
    assert.match(resultText(r), /bullets must be a list of objects/);
  } finally {
    a.close();
  }
});

test("resume_build refuses an invented role, company and dates", async () => {
  const r0 = resumeEnvFor({ withMaster: true });
  const a = await startAssistant({ profileMd: PROFILE_MD, extraEnv: r0.env });
  try {
    const input = resumeInput([GOOD_BULLET]);
    input.experience[0].company = "Acme Holdings";
    const r = await a.call("resume_build", input);
    assert.equal(r.result?.isError, true);
    assert.match(resultText(r), /experience 1 role\/company\/dates/);
    assert.equal(resultText(r).includes("Acme"), false);
  } finally {
    a.close();
  }
});
