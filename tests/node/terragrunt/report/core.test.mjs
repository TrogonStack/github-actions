import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendSummary,
  error,
  getInput,
  info,
  setFailed,
  setOutput,
  warning,
} from "../../../../actions/terragrunt/report/lib/core.mjs";

function captureStdout(run) {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return written.join("");
}

function outputFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "terragrunt-report-")), "output.txt");
  fs.writeFileSync(file, "");
  return file;
}

function withOutputFile(run) {
  const file = outputFile();
  const previous = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = file;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = previous;
    }
  }
  return fs.readFileSync(file, "utf8");
}

function withInput(name, value, run) {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  process.env[key] = value;
  try {
    return run();
  } finally {
    delete process.env[key];
  }
}

test("getInput reads the dash spelling the runner writes", () => {
  assert.equal(
    withInput("report-path", "/tmp/plan.md", () => getInput("report-path")),
    "/tmp/plan.md",
  );
});

test("getInput is empty for an absent input", () => {
  assert.equal(getInput("nothing-set-here"), "");
});

test("getInput trims by default", () => {
  assert.equal(
    withInput("title", "  Plan  ", () => getInput("title")),
    "Plan",
  );
});

test("getInput keeps whitespace when asked", () => {
  assert.equal(
    withInput("title", "  Plan  ", () => getInput("title", { trimWhitespace: false })),
    "  Plan  ",
  );
});

test("getInput enforces required", () => {
  assert.throws(() => getInput("absent-input", { required: true }), {
    message: "Input required and not supplied: absent-input",
  });
});

test("info writes the message and a line ending", () => {
  assert.equal(
    captureStdout(() => info("hello")),
    `hello${os.EOL}`,
  );
});

test("error writes an error annotation", () => {
  assert.equal(
    captureStdout(() => error("broken")),
    `::error::broken${os.EOL}`,
  );
});

test("error escapes what would end the annotation", () => {
  const written = captureStdout(() => error("one\ntwo\rthree 50%"));
  assert.equal(written, `::error::one%0Atwo%0Dthree 50%25${os.EOL}`);
  assert.equal(written.trimEnd().split("\n").length, 1);
});

test("setFailed annotates and sets a failing exit code", () => {
  const previous = process.exitCode;
  try {
    const written = captureStdout(() => setFailed("nope"));
    assert.equal(written, `::error::nope${os.EOL}`);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previous;
  }
});

test("setOutput writes the delimited form", () => {
  const written = withOutputFile(() => setOutput("report-path", "/tmp/plan.md"));
  assert.match(written, /^report-path<<ghadelimiter_[0-9a-f-]{36}\r?\n\/tmp\/plan\.md\r?\nghadelimiter_/);
});

test("setOutput survives a value holding a newline", () => {
  const written = withOutputFile(() => setOutput("report-path", "first\nsecond"));
  const [header, ...rest] = written.split(/\r?\n/);
  const delimiter = header.slice("report-path<<".length);
  assert.deepEqual(rest, ["first", "second", delimiter, ""]);
});

test("setOutput appends rather than replacing", () => {
  const written = withOutputFile(() => {
    setOutput("report-path", "/tmp/plan.md");
    setOutput("exit-code", "0");
  });
  assert.match(written, /^report-path<</);
  assert.match(written, /\nexit-code<</);
});

test("setOutput needs GITHUB_OUTPUT", () => {
  const previous = process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_OUTPUT;
  try {
    assert.throws(() => setOutput("report-path", "/tmp/plan.md"), {
      message: "Unable to find environment variable for file command OUTPUT",
    });
  } finally {
    if (previous !== undefined) {
      process.env.GITHUB_OUTPUT = previous;
    }
  }
});

test("warning writes a warning annotation, escaped", () => {
  assert.equal(
    captureStdout(() => warning("one\ntwo 50%")),
    `::warning::one%0Atwo 50%25${os.EOL}`,
  );
});

test("appendSummary appends markdown as it stands", () => {
  const file = outputFile();
  const previous = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = file;
  try {
    appendSummary("### one\n");
    appendSummary("### two\n");
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_STEP_SUMMARY;
    } else {
      process.env.GITHUB_STEP_SUMMARY = previous;
    }
  }
  assert.equal(fs.readFileSync(file, "utf8"), "### one\n### two\n");
});

test("appendSummary needs GITHUB_STEP_SUMMARY", () => {
  const previous = process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_STEP_SUMMARY;
  try {
    assert.throws(() => appendSummary("x"), {
      message: "Unable to find environment variable for file command STEP_SUMMARY",
    });
  } finally {
    if (previous !== undefined) {
      process.env.GITHUB_STEP_SUMMARY = previous;
    }
  }
});
