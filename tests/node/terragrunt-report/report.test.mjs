import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMENT_BUDGET,
  UNIT_BUDGET,
  fence,
  isNoop,
  linesOf,
  parseRecord,
  render,
  streamLine,
  stripWrapper,
  trim,
  unitOf,
  verdict,
} from "../../../actions/terragrunt-report/lib/report.mjs";
import { FIXTURES, ROOT } from "./fixtures.mjs";

function report(name, extra = {}) {
  return render({ lines: FIXTURES[name], root: ROOT, title: "Plan", ...extra }).markdown;
}

test("parseRecord takes objects only", () => {
  assert.deepEqual(parseRecord('{"level":"stdout"}'), { level: "stdout" });
  assert.equal(parseRecord("[1, 2]"), null);
  assert.equal(parseRecord("null"), null);
  assert.equal(parseRecord("Run Summary"), null);
});

test("unitOf cuts the root off", () => {
  assert.equal(unitOf({ "working-dir": `${ROOT}/apps/web` }, ROOT), "apps/web");
  assert.equal(unitOf({ "working-dir": ROOT }, ROOT), ".");
  assert.equal(unitOf({}, ROOT), "");
});

test("unitOf leaves a directory outside the root whole", () => {
  assert.equal(unitOf({ "working-dir": "/elsewhere/terraform/unit" }, ROOT), "/elsewhere/terraform/unit");
  assert.equal(unitOf({ "working-dir": `${ROOT}-other/unit` }, ROOT), `${ROOT}-other/unit`);
});

test("linesOf drops one terminating newline and reads empty as nothing", () => {
  assert.deepEqual(linesOf({ msg: "a\nb\n" }), ["a", "b"]);
  assert.deepEqual(linesOf({ msg: "a\n\n" }), ["a", ""]);
  assert.deepEqual(linesOf({ msg: "" }), []);
  assert.deepEqual(linesOf({ msg: "\n" }), []);
  assert.deepEqual(linesOf({ msg: 42 }), []);
});

test("streamLine tags each line with its unit", () => {
  const line = JSON.stringify({ level: "stdout", "working-dir": `${ROOT}/dns`, msg: "one\ntwo\n" });
  assert.equal(streamLine(line, ROOT), "[dns] one\n[dns] two");
});

test("streamLine passes a line that is not a record through", () => {
  assert.equal(streamLine("❯❯ Run Summary", ROOT), "❯❯ Run Summary");
});

test("trim drops the lock, the refresh and the trailer", () => {
  const body = [
    "Acquiring state lock. This may take a few moments...",
    "x.y: Refreshing state... [id=1]",
    "x.z: Reading...",
    "x.z: Read complete after 0s [id=z]",
    "",
    "",
    "  + create",
    "─────",
    "Plan: 1 to add, 0 to change, 0 to destroy.",
    "",
    "Note: You didn't use the -out option to save this plan",
    "anything after the note",
  ].join("\n");
  assert.equal(trim(body), "  + create\n\nPlan: 1 to add, 0 to change, 0 to destroy.");
});

test("trim keeps what an apply did", () => {
  const body = "x.y: Creating...\nx.y: Creation complete after 1s [id=y]";
  assert.equal(trim(body), body);
});

test("stripWrapper leaves only the diagnostic", () => {
  const text = [
    "tofu invocation failed in ./db",
    "",
    "Error: access denied",
    "Module ./db has finished with an error",
  ].join("\n");
  assert.equal(stripWrapper(text), "Error: access denied");
});

test("stripWrapper is empty when a unit only failed on a dependency", () => {
  assert.equal(
    stripWrapper("Dependency ./db of module ./app just finished with an error. Module ./app will have to return an error too."),
    "",
  );
});

test("verdict reports an apply by its result, not its plan", () => {
  const body = "Plan: 2 to add, 0 to change, 0 to destroy.\nApply complete! Resources: 1 added, 0 changed, 0 destroyed.";
  assert.equal(verdict(body), "1 added, 0 changed, 0 destroyed");
});

test("verdict reads the plan line", () => {
  assert.equal(verdict("Plan: 1 to add, 2 to change, 3 to destroy."), "1 to add, 2 to change, 3 to destroy");
});

test("verdict names the quiet outcomes", () => {
  assert.equal(verdict("Changes to Outputs:\n  + x = 1"), "outputs only");
  assert.equal(verdict("No changes. Your infrastructure matches the configuration."), "no changes");
  assert.equal(verdict(""), "no output");
});

test("isNoop covers every way of saying nothing happened", () => {
  for (const value of ["no changes", "no output", "0 to add, 0 to change, 0 to destroy", "0 added, 0 changed, 0 destroyed"]) {
    assert.ok(isNoop(value), value);
  }
  for (const value of ["outputs only", "failed", "1 to add, 0 to change, 0 to destroy"]) {
    assert.ok(!isNoop(value), value);
  }
});

test("fence outgrows the longest backtick run", () => {
  assert.equal(fence("plain"), "```");
  assert.equal(fence("a ``` b"), "````");
  assert.equal(fence("a ````` b"), "``````");
});

test("a run with nothing to change is one line and a collapsed table", () => {
  assert.equal(
    report("no-changes"),
    [
      "### Plan",
      "",
      "Every unit matches its configuration.",
      "",
      "<details><summary>Unchanged</summary>",
      "",
      "| Unit | Change |",
      "| --- | --- |",
      "| `dns` | no changes |",
      "| `network` | no changes |",
      "",
      "</details>",
      "",
    ].join("\n"),
  );
});

test("a changed unit gets a row and its diff, without the noise", () => {
  const markdown = report("changes");
  assert.match(markdown, /\| `apps\/web` \| 1 to add, 0 to change, 0 to destroy \|/);
  assert.match(markdown, /<details><summary><code>apps\/web<\/code> · 1 to add/);
  assert.match(markdown, /name = "web 🚀"/);
  assert.doesNotMatch(markdown, /Refreshing state|Read complete|Note: You didn't/);
  assert.doesNotMatch(markdown, /not JSON/);
});

test("an apply is reported by what it did", () => {
  const markdown = report("apply");
  assert.match(markdown, /\| `apps\/api` \| 1 added, 0 changed, 0 destroyed \|/);
  assert.match(markdown, /Creation complete after 2s/);
  assert.match(markdown, /<summary>Unchanged<\/summary>[\s\S]*`apps\/idle` \| 0 added, 0 changed, 0 destroyed/);
});

test("an outputs-only unit is shown, not collapsed", () => {
  assert.match(report("outputs-only"), /\| `shared` \| outputs only \|/);
});

test("a failed unit carries its diagnostics and the run root is not a unit", () => {
  const markdown = report("failed");
  assert.match(markdown, /^\*\*Failed\.\*\*/m);
  assert.match(markdown, /\| `db` \| failed \|/);
  assert.match(markdown, /\| `apps\/worker` \| failed \|/);
  assert.match(markdown, /Error: creating example_thing\.cluster: access denied/);
  assert.doesNotMatch(markdown, /<code>apps\/worker<\/code>/);
  assert.doesNotMatch(markdown, /`\.`/);
  assert.doesNotMatch(markdown, /error occurred/);
  assert.doesNotMatch(markdown, /tofu invocation failed/);
});

test("a unit that failed before tofu wrote anything falls back to its error records", () => {
  const markdown = report("error-only");
  assert.match(markdown, /\| `broken` \| failed \|/);
  assert.match(markdown, /Error: Unclosed configuration block/);
  assert.doesNotMatch(markdown, /Module \.\/broken has finished/);
});

test("backticks in a diff cannot close the fence", () => {
  const markdown = report("backticks");
  assert.match(markdown, /^`````text$/m);
  assert.match(markdown, /^`````$/m);
});

test("one large unit is cut to its own budget", () => {
  const markdown = report("unit-budget");
  assert.match(markdown, /\.\.\. this unit is longer than the comment allows; read it in the job summary/);
  assert.match(markdown, /<code>small<\/code>/);
  assert.ok(markdown.length < UNIT_BUDGET * 2);
});

test("units past the comment budget keep their row and lose their diff", () => {
  const markdown = report("total-budget");
  assert.match(markdown, /_Some units are left out of this comment for length\. The job summary has all of them\._/);
  for (const unit of ["a", "b", "c", "d", "e", "f"]) {
    assert.match(markdown, new RegExp(`\\| \`stack-${unit}\` \\|`));
  }
  assert.ok((markdown.match(/<details><summary><code>/g) ?? []).length < 6);
  assert.ok(markdown.length < COMMENT_BUDGET + 2000);
});

test("output that is not Terragrunt's says so and counts no records", () => {
  const { markdown, records } = render({ lines: FIXTURES["not-terragrunt"], root: ROOT, title: "Plan" });
  assert.equal(records, 0);
  assert.match(markdown, /No unit produced any output\. The run stopped before tofu started\./);
});

test("a run that failed before any unit shows the run's own error", () => {
  assert.equal(
    report("root-failure"),
    [
      "### Plan",
      "",
      "**Failed.**",
      "",
      "````text",
      "Error reading file at path /work/infra/root.hcl: ```unclosed``` block",
      "````",
      "",
      "",
    ].join("\n"),
  );
});

test("a malformed record does not take the report down", () => {
  const markdown = report("outside");
  assert.match(markdown, /`\/elsewhere\/unit` \| no changes/);
  assert.match(markdown, /`odd` \| no output/);
});

test("the preamble sits under the title", () => {
  assert.match(report("no-changes", { preamble: "Dev account." }), /^### Plan\n\nDev account\.\n\nEvery unit/);
});
