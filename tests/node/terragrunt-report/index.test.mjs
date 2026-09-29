import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_REPORT_NAME,
  InputError,
  childEnv,
  readInputs,
  run,
} from "../../../actions/terragrunt-report/lib/index.mjs";
import { FIXTURES, ROOT } from "./fixtures.mjs";

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "terragrunt-report-"));
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result instanceof Promise) return result.finally(restore);
  restore();
  return result;
}

function inputs(values) {
  const env = {};
  for (const name of ["command", "title", "working-directory", "root", "preamble", "report-path", "summary"]) {
    env[`INPUT_${name.toUpperCase()}`] = values[name];
  }
  return env;
}

// A log file and a command that replays it, which is the whole contract with
// whatever the caller really runs.
function replay(dir, name) {
  const log = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(log, `${FIXTURES[name].join("\n")}\n`);
  return `cat "$LOG"`;
}

async function capture(options) {
  const written = [];
  const result = await run({ write: (text) => written.push(text), ...options });
  return { ...result, stream: written.join("") };
}

test("readInputs needs a command and a title", () => {
  withEnv(inputs({ title: "Plan" }), () => {
    assert.throws(() => readInputs(), InputError);
  });
  withEnv(inputs({ command: "true" }), () => {
    assert.throws(() => readInputs(), InputError);
  });
});

test("readInputs defaults the root to the working directory and the report to the runner's temp", () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, "infra"));
  withEnv(inputs({ command: "true", title: "Plan", "working-directory": "infra" }), () => {
    const read = readInputs({ cwd: dir, tmp: "/runner/tmp" });
    assert.equal(read.workingDirectory, path.join(dir, "infra"));
    assert.equal(read.root, path.join(dir, "infra"));
    assert.equal(read.reportPath, path.join("/runner/tmp", DEFAULT_REPORT_NAME));
    assert.equal(read.summary, true);
  });
});

test("readInputs resolves an explicit root against the workspace", () => {
  const dir = scratch();
  withEnv(inputs({ command: "true", title: "Plan", root: "infra/terraform", summary: "false" }), () => {
    const read = readInputs({ cwd: dir });
    assert.equal(read.root, path.join(dir, "infra/terraform"));
    assert.equal(read.summary, false);
  });
});

test("readInputs refuses a summary that is not a boolean", () => {
  withEnv(inputs({ command: "true", title: "Plan", summary: "yes" }), () => {
    assert.throws(() => readInputs(), { message: /`summary` input must be `true` or `false`/ });
  });
});

test("readInputs refuses a working directory that does not exist", () => {
  withEnv(inputs({ command: "true", title: "Plan", "working-directory": "does-not-exist" }), () => {
    assert.throws(() => readInputs({ cwd: scratch() }), { message: /names no directory/ });
  });
});

test("childEnv forces the JSON log format", () => {
  const env = childEnv({ TG_LOG_FORMAT: "pretty", TG_LOG_CUSTOM_FORMAT: "%msg", KEEP: "1" });
  assert.equal(env.TG_LOG_FORMAT, "json");
  assert.equal(env.TG_LOG_CUSTOM_FORMAT, undefined);
  assert.equal(env.KEEP, "1");
});

test("run streams per unit, writes the report and keeps the command's status", async () => {
  const dir = scratch();
  const command = `${replay(dir, "failed")}; exit 3`;
  const reportPath = path.join(dir, "out", "plan.md");
  const summary = path.join(dir, "summary.md");

  const result = await withEnv({ GITHUB_STEP_SUMMARY: summary }, () =>
    capture({
      command,
      title: "Plan",
      workingDirectory: dir,
      root: ROOT,
      reportPath,
      env: { ...process.env, LOG: path.join(dir, "failed.jsonl") },
    }),
  );

  assert.equal(result.exitCode, 3);
  assert.equal(result.reportPath, reportPath);
  assert.match(result.stream, /^\[db\] Error: creating example_thing\.cluster: access denied$/m);
  assert.match(result.stream, /^❯❯ Run Summary/m);
  const markdown = fs.readFileSync(reportPath, "utf8");
  assert.match(markdown, /\| `db` \| failed \|/);
  assert.equal(fs.readFileSync(summary, "utf8"), markdown);
});

test("run hands the command the JSON log format", async () => {
  const dir = scratch();
  const result = await capture({
    command: 'printf \'{"level":"stdout","working-dir":"%s/u","msg":"%s"}\\n\' "$PWD" "$TG_LOG_FORMAT"',
    title: "Plan",
    workingDirectory: dir,
    root: fs.realpathSync(dir),
    reportPath: path.join(dir, "plan.md"),
    summary: false,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stream, /^\[u\] json$/m);
});

test("run merges stderr into the log in the order it was written", async () => {
  const dir = scratch();
  const result = await capture({
    command: "echo one; echo two >&2; echo three",
    title: "Plan",
    workingDirectory: dir,
    root: dir,
    reportPath: path.join(dir, "plan.md"),
    summary: false,
  });
  assert.equal(result.stream, "one\ntwo\nthree\n");
});

test("run fails a pipeline that fails part way", async () => {
  const dir = scratch();
  const result = await capture({
    command: "false | cat",
    title: "Plan",
    workingDirectory: dir,
    root: dir,
    reportPath: path.join(dir, "plan.md"),
    summary: false,
  });
  assert.equal(result.exitCode, 1);
});

test("run keeps a last line with no newline", async () => {
  const dir = scratch();
  const result = await capture({
    command: 'printf \'{"level":"stdout","working-dir":"/r/u","msg":"Plan: 1 to add, 0 to change, 0 to destroy."}\'',
    title: "Plan",
    workingDirectory: dir,
    root: "/r",
    reportPath: path.join(dir, "plan.md"),
    summary: false,
  });
  assert.match(fs.readFileSync(path.join(dir, "plan.md"), "utf8"), /\| `u` \| 1 to add/);
  assert.equal(result.exitCode, 0);
});

test("run forwards a cancellation to the command's process group", async () => {
  const dir = scratch();
  const marker = path.join(dir, "interrupted");
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const pending = run({
    // The trap is on the grandchild, which is the process a cancellation has to
    // reach: tofu under Terragrunt under the shell.
    command: `bash -c 'trap "touch ${marker}; exit 0" INT; echo ready; while :; do sleep 0.1; done' ; exit 130`,
    title: "Plan",
    workingDirectory: dir,
    root: dir,
    reportPath: path.join(dir, "plan.md"),
    summary: false,
    write: (text) => {
      if (text.startsWith("ready")) ready();
    },
  });
  await started;
  process.emit("SIGINT", "SIGINT");
  const result = await pending;
  assert.ok(fs.existsSync(marker), "the grandchild never saw the interrupt");
  assert.notEqual(result.exitCode, 0);
});
