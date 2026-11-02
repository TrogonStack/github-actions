import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { InputError, run, skipReason } from "../../../actions/repo-health/lib/index.mjs";

const CITATION = `cff-version: 1.2.0
message: If you use this software, please cite it as below.
title: Widgets
authors:
  - name: Acme
`;

function repository(files = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "repo-health-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

function citation(directory, skip = "") {
  return run({ inputs: { directory, checks: { "citation-cff": { skip } } } }).find((result) => result.id === "citation-cff");
}

// assert.throws does not hand back the error, and every failure case here is
// about the message it carries.
function failure(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof InputError, `not an InputError: ${error}`);
    return error;
  }
  assert.fail("expected an InputError");
}

test("a complete CITATION.cff passes", () => {
  assert.deepEqual(citation(repository({ "CITATION.cff": CITATION })).problems, []);
});

test("a missing CITATION.cff fails", () => {
  const { problems } = citation(repository());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /No CITATION\.cff/);
});

test("a lowercase citation.cff does not count, because GitHub ignores it", () => {
  const { problems } = citation(repository({ "citation.cff": CITATION }));
  assert.match(problems[0], /No CITATION\.cff/);
});

test("a CITATION.cff missing required keys names them", () => {
  const { problems } = citation(repository({ "CITATION.cff": "cff-version: 1.2.0\ntitle: Widgets\n" }));
  assert.match(problems[0], /`message`, `authors`/);
});

test("a nested key does not stand in for a top-level one", () => {
  const content = "cff-version: 1.2.0\nmessage: Cite.\nauthors:\n  - title: Dr\n";
  const { problems } = citation(repository({ "CITATION.cff": content }));
  assert.match(problems[0], /`title`/);
});

test("a skipped check still runs and carries its reason", () => {
  const result = citation(repository(), "not published yet");
  assert.equal(result.skipReason, "not published yet");
  assert.equal(result.problems.length, 1);
});

test("an empty skip runs the check", () => {
  assert.equal(skipReason("citation-cff", ""), undefined);
});

test("a bare boolean is not a reason", () => {
  for (const value of ["true", "FALSE", "yes", "1"]) {
    assert.match(failure(() => skipReason("citation-cff", value)).message, /`citation-cff-skip` is/);
  }
});

test("a check with no config runs", () => {
  const result = run({ inputs: { directory: repository(), checks: {} } })[0];
  assert.equal(result.skipReason, undefined);
});

test("a missing directory asks for a checkout", () => {
  const missing = path.join(os.tmpdir(), "repo-health-does-not-exist");
  assert.match(failure(() => run({ inputs: { directory: missing, checks: {} } })).message, /Check the repository out/);
});
