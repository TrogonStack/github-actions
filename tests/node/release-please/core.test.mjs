import assert from "node:assert/strict";
import { test } from "node:test";

import { getBooleanInput } from "../../../actions/release-please/lib/core.mjs";

function withInput(name, value, run) {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  process.env[key] = value;
  try {
    return run();
  } finally {
    delete process.env[key];
  }
}

test("getBooleanInput reads the YAML true spellings", () => {
  for (const value of ["true", "True", "TRUE"]) {
    assert.equal(withInput("require_initial_version", value, () => getBooleanInput("require_initial_version")), true);
  }
});

test("getBooleanInput reads the YAML false spellings", () => {
  for (const value of ["false", "False", "FALSE"]) {
    assert.equal(withInput("require_initial_version", value, () => getBooleanInput("require_initial_version")), false);
  }
});

test("getBooleanInput rejects anything else", () => {
  assert.throws(
    () => withInput("require_initial_version", "yes", () => getBooleanInput("require_initial_version")),
    TypeError,
  );
});
