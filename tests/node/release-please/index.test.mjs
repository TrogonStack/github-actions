import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  CONFIG_FILE,
  InputError,
  readConfig,
  validateInitialVersion,
} from "../../../actions/release-please/lib/index.mjs";

// assert.throws does not hand back the error, and every failure case here is
// about the message it carries.
function failure(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof InputError, `not an InputError: ${error}`);
    return error;
  }
  assert.fail("expected an InputError");
}

test("every package setting initial-version passes", () => {
  const logs = validateInitialVersion({
    packages: {
      "actions/a": { component: "a", "initial-version": "0.0.1" },
      "actions/b": { component: "b", "initial-version": "1.0.0" },
    },
  });
  assert.deepEqual(logs, [
    "Package 'actions/a' starts at 0.0.1.",
    "Package 'actions/b' starts at 1.0.0.",
  ]);
});

test("a top-level initial-version covers every package", () => {
  const logs = validateInitialVersion({
    "initial-version": "0.0.1",
    packages: { ".": { component: "root" } },
  });
  assert.deepEqual(logs, ["Package '.' starts at 0.0.1."]);
});

test("a package value wins over the top-level one", () => {
  const logs = validateInitialVersion({
    "initial-version": "0.0.1",
    packages: { ".": { "initial-version": "0.1.0" } },
  });
  assert.deepEqual(logs, ["Package '.' starts at 0.1.0."]);
});

test("an empty package value is not rescued by the top-level one", () => {
  const error = failure(() =>
    validateInitialVersion({
      "initial-version": "0.0.1",
      packages: {
        "actions/a": {},
        "actions/b": { "initial-version": "" },
        "actions/c": { "initial-version": null },
      },
    }),
  );
  assert.match(error.message, /Missing: actions\/b, actions\/c\.$/);
});

test("a package without initial-version fails and is named", () => {
  const error = failure(() =>
    validateInitialVersion({
      packages: {
        "actions/a": { "initial-version": "0.0.1" },
        "actions/b": { component: "b" },
        "actions/c": {},
      },
    }),
  );
  assert.match(error.message, /Missing: actions\/b, actions\/c\.$/);
});

test("an empty initial-version is not set", () => {
  const error = failure(() =>
    validateInitialVersion({ packages: { ".": { "initial-version": "  " } } }),
  );
  assert.match(error.message, /Missing: \.\.$/);
});

test("a non-string initial-version is not set", () => {
  failure(() => validateInitialVersion({ packages: { ".": { "initial-version": 1 } } }));
});

test("a config without packages fails", () => {
  const error = failure(() => validateInitialVersion({ "release-type": "simple" }));
  assert.match(error.message, /has no `packages`/);
});

test("an empty packages object fails", () => {
  failure(() => validateInitialVersion({ packages: {} }));
});

test("a config that is not an object fails", () => {
  failure(() => validateInitialVersion([]));
});

function workspace(contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-please-"));
  if (contents !== undefined) {
    fs.mkdirSync(path.join(root, ".github"));
    fs.writeFileSync(path.join(root, CONFIG_FILE), contents);
  }
  return root;
}

test("readConfig parses the configuration in the workspace", () => {
  const root = workspace(JSON.stringify({ packages: { ".": {} } }));
  assert.deepEqual(readConfig(root), { packages: { ".": {} } });
});

test("readConfig asks for a checkout when the file is absent", () => {
  const error = failure(() => readConfig(workspace()));
  assert.match(error.message, /Check the repository out before this action/);
});

test("readConfig rejects invalid JSON", () => {
  const error = failure(() => readConfig(workspace("{")));
  assert.match(error.message, /is not valid JSON/);
});

test("the repository's own configuration passes", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  validateInitialVersion(readConfig(root));
});
