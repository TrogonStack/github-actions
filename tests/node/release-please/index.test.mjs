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
  validateReleaseDefaults,
  validateSignoff,
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

const defaults = JSON.parse(
  fs.readFileSync(new URL("../../../actions/release-please/validation-defaults.json", import.meta.url), "utf8"),
);

test("the shipped defaults match native release defaults", () => {
  assert.deepEqual(defaults, {
    "bump-patch-for-minor-pre-major": false,
    draft: false,
    "draft-pull-request": false,
    prerelease: false,
    "include-v-in-tag": true,
  });
  validateReleaseDefaults({ packages: { ".": {} } });
});

test("effective policy settings inherit root or native defaults", () => {
  validateReleaseDefaults({ ...defaults, packages: { ".": {}, other: { ...defaults } } });
  for (const [key, expected] of Object.entries(defaults)) {
    validateReleaseDefaults({
      [key]: !expected,
      packages: { ".": { [key]: expected }, other: { [key]: expected } },
    });
    const error = failure(() => validateReleaseDefaults({
      [key]: !expected,
      packages: { compliant: { [key]: expected }, inherited: {} },
    }));
    assert.match(error.message, /Package 'inherited'/);
    assert.ok(error.message.includes(`${key}: ${expected}`));
  }
});

test("invalid root booleans fail even when all packages shadow the setting", () => {
  for (const [key, expected] of Object.entries(defaults)) {
    for (const value of [null, "false", 0, undefined, [], {}]) {
      const error = failure(() => validateReleaseDefaults({
        [key]: value,
        packages: { ".": { [key]: expected } },
      }));
      assert.match(error.message, /to a boolean/);
      assert.ok(error.message.includes(key));
    }
  }
});

test("explicit package null and strings are not rescued by root policy defaults", () => {
  for (const [key, expected] of Object.entries(defaults)) {
    for (const value of [null, "false", 0, undefined, [], {}]) {
      const error = failure(() => validateReleaseDefaults({
        [key]: expected,
        packages: { malformed: { [key]: value } },
      }));
      assert.match(error.message, /Package 'malformed'/);
      assert.match(error.message, /to a boolean/);
    }
    validateReleaseDefaults({ [key]: expected, packages: { ".": { [key]: expected } } });
  }
});

test("strategy booleans may vary but must actually be booleans", () => {
  for (const key of ["bump-minor-pre-major", "include-component-in-tag", "separate-pull-requests"]) {
    for (const value of [true, false]) {
      validateReleaseDefaults({ [key]: value, packages: { ".": {}, opposite: { [key]: !value } } });
    }
    for (const value of [null, "true", 1]) {
      failure(() => validateReleaseDefaults({ [key]: value, packages: { ".": {} } }));
      failure(() => validateReleaseDefaults({ packages: { ".": { [key]: value } } }));
    }
  }
});

test("release strategies and unknown extra settings remain caller-owned", () => {
  validateReleaseDefaults({
    "release-type": "simple",
    "tag-separator": "@",
    plugins: [{ type: "cargo-workspace", "merge": false }],
    "custom-setting": null,
    packages: Object.fromEntries(["simple", "rust", "node", "python", "go", "elixir"].map((type) => [type, {
      "release-type": type,
      component: type,
      "tag-separator": "-",
      "custom-setting": { enabled: "caller-specific" },
    }])),
  });
});

test("policy validation requires a nonempty package object and valid option objects", () => {
  for (const config of [null, false, [], "config", {}, { packages: {} }, { packages: [] }]) {
    failure(() => validateReleaseDefaults(config));
  }
  for (const options of [null, false, [], "options", 1]) {
    const error = failure(() => validateReleaseDefaults({ packages: { invalid: options } }));
    assert.match(error.message, /Package 'invalid'.*JSON object/);
  }
});

test("signoff requires a root nonempty string without imposing an identity", () => {
  for (const signoff of [undefined, "", " \t ", null, false, 123, [], {}]) {
    failure(() => validateSignoff({ signoff }));
  }
  failure(() => validateSignoff([]));
  validateSignoff({ signoff: "Example Bot" });
  validateSignoff({ signoff: "  Another contributor  " });
  failure(() => validateSignoff({ packages: { ".": { signoff: "Example Bot" } } }));
});

test("the repository's own configuration satisfies mandatory release validation", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const config = readConfig(root);
  validateReleaseDefaults(config);
  validateSignoff(config);
});
