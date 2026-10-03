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
    assert.equal(withInput("require-initial-version", value, () => getBooleanInput("require-initial-version")), true);
  }
});

test("getBooleanInput reads the YAML false spellings", () => {
  for (const value of ["false", "False", "FALSE"]) {
    assert.equal(withInput("require-initial-version", value, () => getBooleanInput("require-initial-version")), false);
  }
});

test("getBooleanInput rejects anything else", () => {
  assert.throws(
    () => withInput("require-initial-version", "yes", () => getBooleanInput("require-initial-version")),
    TypeError,
  );
});
