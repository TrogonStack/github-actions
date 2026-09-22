import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_LABEL_PREFIX,
  InputError,
  readEventLabels,
  resolve,
} from "../../../actions/runs-on-selector/lib/index.mjs";

const POOLS = JSON.stringify({
  github: "ubuntu-24.04",
  "github-arm": "ubuntu-24.04-arm",
  fleet: "acme-ci-linux-x64",
});

function pick(overrides) {
  return resolve({
    poolsJson: POOLS,
    defaultPoolName: "github",
    labelPrefix: "",
    eventLabels: [],
    ...overrides,
  });
}

// assert.throws does not hand back the error, and every failure case here is
// about the message it carries.
function failure(overrides) {
  try {
    pick(overrides);
  } catch (error) {
    assert.ok(error instanceof InputError, `not an InputError: ${error}`);
    return error;
  }
  assert.fail("expected an InputError");
}

test("no label takes default", () => {
  const { runsOn, poolName } = pick({ eventLabels: ["bug", "enhancement"] });
  assert.equal(runsOn, "ubuntu-24.04");
  assert.equal(poolName, "github");
});

test("no label logs the default", () => {
  const { logs } = pick({});
  assert.match(logs[0], /^No runs-on:\* label on this run, so the default pool 'github' applies\.$/);
});

test("label picks pool", () => {
  const { runsOn, poolName } = pick({ eventLabels: ["runs-on:fleet"] });
  assert.equal(runsOn, "acme-ci-linux-x64");
  assert.equal(poolName, "fleet");
});

test("label logs pool name", () => {
  const { logs } = pick({ eventLabels: ["runs-on:fleet"] });
  assert.deepEqual(logs, [
    "Label 'runs-on:fleet' asks for pool 'fleet'.",
    "Pool 'fleet' resolves to runner label 'acme-ci-linux-x64'.",
  ]);
});

test("a pool name with a dash resolves", () => {
  const { runsOn, poolName } = pick({ eventLabels: ["runs-on:github-arm"] });
  assert.equal(runsOn, "ubuntu-24.04-arm");
  assert.equal(poolName, "github-arm");
});

test("unknown label fails", () => {
  const error = failure({ eventLabels: ["runs-on:nope"] });
  assert.match(error.message, /No pool named 'nope' in `pools-json`/);
});

test("unknown label lists the known pools", () => {
  const error = failure({ eventLabels: ["runs-on:nope"] });
  assert.match(
    error.message,
    /It knows: runs-on:github, runs-on:github-arm, runs-on:fleet\.$/,
  );
});

test("bare prefix fails", () => {
  const error = failure({ eventLabels: ["runs-on:"] });
  assert.match(error.message, /^The label 'runs-on:' names no pool\. Ask for one of: /);
});

test("two labels fail", () => {
  const error = failure({ eventLabels: ["runs-on:fleet", "runs-on:github"] });
  assert.match(error.message, /^This run carries 2 runs-on:\* labels /);
});

test("two labels name both", () => {
  const error = failure({ eventLabels: ["runs-on:fleet", "runs-on:github"] });
  assert.match(
    error.message,
    /\(runs-on:fleet runs-on:github\)\. Leave exactly one, or none to take the default\.$/,
  );
});

test("duplicate label is one", () => {
  const { poolName } = pick({ eventLabels: ["runs-on:fleet", "runs-on:fleet"] });
  assert.equal(poolName, "fleet");
});

test("unrelated labels are ignored", () => {
  const { poolName } = pick({
    eventLabels: ["runner:fleet", "runs-on", "needs runs-on:fleet"],
  });
  assert.equal(poolName, "github");
});

test("push takes default", () => {
  const { poolName } = pick({ eventLabels: [] });
  assert.equal(poolName, "github");
});

test("default-pool-name must name a pool", () => {
  const error = failure({ defaultPoolName: "nope" });
  assert.match(error.message, /^The `default-pool-name` input 'nope' names no pool in `pools-json`\./);
});

test("default-pool-name is required", () => {
  const error = failure({ defaultPoolName: "" });
  assert.match(error.message, /^The `default-pool-name` input is required, and must name one of `pools-json`: /);
});

test("pools must be json", () => {
  const error = failure({ poolsJson: "{" });
  assert.match(error.message, /^The `pools-json` input must be a JSON object /);
});

test("pools must be an object", () => {
  failure({ poolsJson: '["github"]' });
});

test("pools must not be empty", () => {
  const error = failure({ poolsJson: "{}" });
  assert.match(error.message, /is an empty object, so there is nothing to schedule on\.$/);
});

test("pool names are restricted to the label charset", () => {
  const error = failure({ poolsJson: '{"GitHub":"ubuntu-24.04"}', defaultPoolName: "GitHub" });
  assert.match(error.message, /must be lowercase letters, digits and dashes/);
});

test("a pool maps to a string", () => {
  const error = failure({ poolsJson: '{"github":["a","b"]}' });
  assert.match(error.message, /must map to a single non-empty runner label\.$/);
});

test("a pool label is non-empty", () => {
  failure({ poolsJson: '{"github":""}' });
});

test("the default prefix is the published vocabulary", () => {
  assert.equal(DEFAULT_LABEL_PREFIX, "runs-on");
});

test("an empty label-prefix takes the default", () => {
  const { poolName } = pick({ labelPrefix: "", eventLabels: ["runs-on:fleet"] });
  assert.equal(poolName, "fleet");
});

test("label-prefix changes which labels are read", () => {
  const { poolName } = pick({
    labelPrefix: "action-runner",
    eventLabels: ["action-runner:fleet", "runs-on:github-arm"],
  });
  assert.equal(poolName, "fleet");
});

test("label-prefix appears in the messages that teach the vocabulary", () => {
  const error = failure({ labelPrefix: "action-runner", eventLabels: ["action-runner:nope"] });
  assert.match(error.message, /It knows: action-runner:github, action-runner:github-arm, action-runner:fleet\.$/);
});

test("label-prefix rejects a colon, which the action appends itself", () => {
  const error = failure({ labelPrefix: "action-runner:" });
  assert.match(error.message, /^The `label-prefix` input must be letters, digits/);
});

test("label-prefix rejects a space", () => {
  failure({ labelPrefix: "runs on" });
});

function writeEvent(payload) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runs-on-selector-")), "event.json");
  fs.writeFileSync(file, payload);
  return file;
}

test("event labels come from the pull request", () => {
  const file = writeEvent(
    JSON.stringify({ pull_request: { labels: [{ name: "runs-on:fleet" }, { name: "bug" }] } }),
  );
  assert.deepEqual(readEventLabels(file), ["runs-on:fleet", "bug"]);
});

test("an event with no pull request has no labels", () => {
  assert.deepEqual(readEventLabels(writeEvent(JSON.stringify({ ref: "refs/heads/main" }))), []);
});

test("an unreadable event payload fails", () => {
  assert.throws(() => readEventLabels("/nonexistent/event.json"), InputError);
});
