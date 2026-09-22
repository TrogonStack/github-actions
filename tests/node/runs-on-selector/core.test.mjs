import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  error,
  getInput,
  info,
  setFailed,
  setOutput,
} from "../../../actions/runs-on-selector/lib/core.mjs";

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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runs-on-selector-")), "output.txt");
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
    withInput("pools-json", '{"github":"ubuntu-24.04"}', () => getInput("pools-json")),
    '{"github":"ubuntu-24.04"}',
  );
});

test("getInput is empty for an absent input", () => {
  assert.equal(getInput("nothing-set-here"), "");
});

test("getInput trims by default", () => {
  assert.equal(
    withInput("pool", "  fleet  ", () => getInput("pool")),
    "fleet",
  );
});

test("getInput keeps whitespace when asked", () => {
  assert.equal(
    withInput("pool", "  fleet  ", () => getInput("pool", { trimWhitespace: false })),
    "  fleet  ",
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
  const written = withOutputFile(() => setOutput("runs-on", "ubuntu-24.04"));
  assert.match(written, /^runs-on<<ghadelimiter_[0-9a-f-]{36}\r?\nubuntu-24\.04\r?\nghadelimiter_/);
});

test("setOutput survives a value holding a newline", () => {
  const written = withOutputFile(() => setOutput("runs-on", "first\nsecond"));
  const [header, ...rest] = written.split(/\r?\n/);
  const delimiter = header.slice("runs-on<<".length);
  assert.deepEqual(rest, ["first", "second", delimiter, ""]);
});

test("setOutput appends rather than replacing", () => {
  const written = withOutputFile(() => {
    setOutput("runs-on", "ubuntu-24.04");
    setOutput("pool", "github");
  });
  assert.match(written, /^runs-on<</);
  assert.match(written, /\npool<</);
});

test("setOutput needs GITHUB_OUTPUT", () => {
  const previous = process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_OUTPUT;
  try {
    assert.throws(() => setOutput("runs-on", "ubuntu-24.04"), {
      message: "Unable to find environment variable for file command OUTPUT",
    });
  } finally {
    if (previous !== undefined) {
      process.env.GITHUB_OUTPUT = previous;
    }
  }
});
