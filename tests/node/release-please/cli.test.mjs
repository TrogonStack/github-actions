import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const entry = path.resolve(import.meta.dirname, "../../../actions/release-please/lib/main.mjs");

function config(overrides = {}) {
  return {
    signoff: "Release contributor",
    "initial-version": "0.0.1",
    packages: { ".": {} },
    ...overrides,
  };
}

function run(t, contents, initial = "true", script = entry) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "release-please-cli-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  if (contents !== undefined) {
    fs.mkdirSync(path.join(workspace, ".github"));
    fs.writeFileSync(path.join(workspace, ".github/release-please-config.json"), JSON.stringify(contents));
  }
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, GITHUB_WORKSPACE: workspace, INPUT_REQUIRE_INITIAL_VERSION: initial },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return result;
}

function rejected(result, pattern) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^::error::/);
  assert.match(result.stdout, pattern);
  assert.equal(result.stderr, "");
}

test("CLI rejects missing, blank, and non-string signoff", (t) => {
  for (const value of [undefined, "", " \t ", null, false, 123, [], {}]) {
    rejected(run(t, config({ signoff: value })), /signoff/);
  }
});

test("CLI rejects forbidden root and package policy flags", (t) => {
  for (const flag of ["bump-patch-for-minor-pre-major", "draft", "draft-pull-request", "prerelease"]) {
    rejected(run(t, config({ [flag]: true })), new RegExp(flag));
    rejected(run(t, config({ packages: { ".": { [flag]: true } } })), new RegExp(flag));
  }
  rejected(run(t, config({ "include-v-in-tag": false })), /include-v-in-tag/);
  rejected(run(t, config({ packages: { ".": { "include-v-in-tag": false } } })), /include-v-in-tag/);
});

test("disabling initial-version validation preserves policy and signoff validation", (t) => {
  rejected(run(t, config({ signoff: "" }), "false"), /signoff/);
  rejected(run(t, config({ draft: true }), "false"), /draft/);
  rejected(run(t, undefined, "false"), /Check the repository out/);
});

test("CLI rejects malformed package options even with root defaults", (t) => {
  for (const value of [null, false, "options", 123, []]) {
    rejected(run(t, config({ packages: { malformed: value } })), /package/i);
  }
});

test("CLI accepts native defaults and package release-type variation", (t) => {
  const packages = Object.fromEntries(["simple", "rust", "node", "python", "go", "elixir"].map((type) => [type, { "release-type": type }]));
  const result = run(t, config({ "bump-minor-pre-major": true, "include-component-in-tag": false, "include-v-in-tag": true, "tag-separator": "-", "separate-pull-requests": false, packages }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /starts at 0\.0\.1/);
});

test("initial-version opt-out accepts missing initial versions when mandatory guards pass", (t) => {
  const result = run(t, { signoff: "Release contributor", packages: { ".": {} } }, "false");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /not checked/);
});

test("CLI preserves invalid input errors", (t) => {
  rejected(run(t, config(), "yes"), /Input does not meet YAML 1\.2/);
});

test("CLI escapes policy errors containing workflow-command characters", (t) => {
  const result = run(t, config({ packages: { "pkg%notice\r\n::warning::forged": { draft: true } } }));
  rejected(result, /pkg%25notice%0D%0A::warning::forged/);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("CLI rejects malformed policy booleans in root and packages", (t) => {
  for (const key of ["draft", "include-v-in-tag", "bump-minor-pre-major", "include-component-in-tag", "separate-pull-requests"]) {
    rejected(run(t, config({ [key]: null })), /to a boolean/);
    rejected(run(t, config({ packages: { ".": { [key]: "false" } } })), /to a boolean/);
  }
});

test("CLI accepts a compliant package override of a root setting", (t) => {
  const result = run(t, config({ draft: true, packages: { ".": { draft: false } } }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("the shipped action reads its local policy from a separate installation", (t) => {
  const installation = fs.mkdtempSync(path.join(os.tmpdir(), "release-please-action-"));
  t.after(() => fs.rmSync(installation, { recursive: true, force: true }));
  fs.cpSync(path.resolve(import.meta.dirname, "../../../actions/release-please"), installation, { recursive: true });
  const result = run(t, config(), "true", path.join(installation, "lib/main.mjs"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("a changed shared policy does not redefine omitted upstream settings", (t) => {
  const installation = fs.mkdtempSync(path.join(os.tmpdir(), "release-please-policy-"));
  t.after(() => fs.rmSync(installation, { recursive: true, force: true }));
  fs.cpSync(path.resolve(import.meta.dirname, "../../../actions/release-please"), installation, { recursive: true });
  const policyFile = path.join(installation, "validation-defaults.json");
  const policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  policy.draft = true;
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  const script = path.join(installation, "lib/main.mjs");
  rejected(run(t, config(), "true", script), /draft: true/);
  const result = run(t, config({ draft: true }), "true", script);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
