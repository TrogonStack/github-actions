// Synthetic Terragrunt JSON logs, one array of lines per case. They are built
// rather than recorded so that no real run's paths, accounts or resource names
// end up in a public repository. The record shape is Terragrunt's: one object
// per line, the unit in `working-dir`, the stream in `level`, the text in `msg`.

export const ROOT = "/work/infra";

const RULE = "─".repeat(77);

function record(unit, level, msg, extra = {}) {
  const dir = unit === "." ? ROOT : `${ROOT}/${unit}`;
  return JSON.stringify({
    time: "2026-01-01T00:00:00Z",
    level,
    "working-dir": dir,
    ...extra,
    msg,
  });
}

const tofu = { "tf-path": "tofu", "tf-command-args": ["plan", "-input=false", "-no-color"] };
const out = (unit, msg) => record(unit, "stdout", msg, tofu);
const err = (unit, msg) => record(unit, "stderr", msg, tofu);
const fail = (unit, msg) => record(unit, "error", msg);
const note = (unit, msg) => record(unit, "info", msg);

const trailer = [
  RULE,
  "",
  "Note: You didn't use the -out option to save this plan, so OpenTofu can't",
  'guarantee to take exactly these actions if you run "tofu apply" now.',
  "",
].join("\n");

function refresh(n) {
  return Array.from({ length: n }, (_, i) => `example_thing.item[${i}]: Refreshing state... [id=${i}]`).join("\n");
}

function create(name, attrs) {
  return [
    `  # example_thing.${name} will be created`,
    `  + resource "example_thing" "${name}" {`,
    ...Object.entries(attrs).map(([k, v]) => `      + ${k} = ${v}`),
    "    }",
  ].join("\n");
}

const header =
  "\nOpenTofu used the selected providers to generate the following execution\nplan. Resource actions are indicated with the following symbols:\n  + create\n\nOpenTofu will perform the following actions:\n";

function bigDiff(name, chars) {
  const lines = [];
  let i = 0;
  while (lines.join("\n").length < chars) {
    lines.push(`      + line_${String(i++).padStart(5, "0")} = "${"x".repeat(60)}"`);
  }
  return `  # example_thing.${name} will be created\n  + resource "example_thing" "${name}" {\n${lines.join("\n")}\n    }\n`;
}

export const FIXTURES = {
  "no-changes": [
    note("network", "Downloading providers"),
    out("network", `Acquiring state lock. This may take a few moments...\n${refresh(3)}\n`),
    out("network", "\nNo changes. Your infrastructure matches the configuration.\n\nOpenTofu has compared your real infrastructure against your configuration\nand found no differences, so no changes are needed.\n"),
    out("network", "Releasing state lock. This may take a few moments...\n"),
    out("dns", "\nNo changes. Your infrastructure matches the configuration.\n"),
    "",
    "❯❯ Run Summary  2 units  4s",
    "   ────────────────────────────",
    "   Succeeded    2",
  ],
  changes: [
    out("dns", "\nNo changes. Your infrastructure matches the configuration.\n"),
    out("apps/web", `${refresh(4)}\nexample_lookup.zone: Reading...\nexample_lookup.zone: Read complete after 1s [id=zone]\n`),
    out("apps/web", header),
    out("apps/web", `\n${create("site", { name: '"web 🚀"', id: "(known after apply)" })}\n\nPlan: 1 to add, 0 to change, 0 to destroy.\n`),
    out("apps/web", `\n${trailer}`),
    err("apps/web", "\nWarning: Deprecated attribute\n\n  on main.tf line 4:\n   4:   legacy = true\n\nThe attribute is deprecated.\n"),
    "Some line a wrapper printed that is not JSON",
    "[1, 2, 3]",
  ],
  apply: [
    out("apps/api", header),
    out("apps/api", `\n${create("svc", { name: '"api"' })}\n\nPlan: 1 to add, 0 to change, 0 to destroy.\n`),
    out("apps/api", "example_thing.svc: Creating...\nexample_thing.svc: Creation complete after 2s [id=svc]\n"),
    out("apps/api", "\nApply complete! Resources: 1 added, 0 changed, 0 destroyed.\n"),
    out("apps/idle", "\nApply complete! Resources: 0 added, 0 changed, 0 destroyed.\n"),
  ],
  "outputs-only": [
    out("shared", "\nChanges to Outputs:\n  + endpoint = \"https://example.test\"\n\nYou can apply this plan to save these new output values to the OpenTofu\nstate, without changing any real infrastructure.\n"),
    out("shared", `\n${trailer}`),
  ],
  failed: [
    out("db", header),
    out("db", `\n${create("cluster", { size: "3" })}\n`),
    err("db", "\nError: creating example_thing.cluster: access denied\n\n  with example_thing.cluster,\n  on main.tf line 1, in resource \"example_thing\" \"cluster\":\n   1: resource \"example_thing\" \"cluster\" {\n\n"),
    fail("db", "tofu invocation failed in ./db"),
    fail("db", "Module ./db has finished with an error"),
    fail("apps/worker", "Dependency ./db of module ./apps/worker just finished with an error. Module ./apps/worker will have to return an error too."),
    fail("apps/worker", "Module ./apps/worker has finished with an error"),
    out("dns", "\nNo changes. Your infrastructure matches the configuration.\n"),
    fail(".", "error occurred:\n\n* Failed to execute \"tofu plan -input=false -no-color\" in ./db\n  Error: creating example_thing.cluster: access denied\n"),
    "❯❯ Run Summary  3 units  9s",
    "   Failed       2",
  ],
  "error-only": [
    fail("broken", "OpenTofu encountered problems during initialization, including problems\nwith the configuration, described below.\n"),
    fail("broken", "\nError: Unclosed configuration block\n\n  on main.tf line 1, in resource \"bad\":\n   1: resource \"bad\" {\n\nThere is no closing brace for this block before the end of the file.\n\n"),
    fail("broken", "tofu invocation failed in ./broken"),
    fail("broken", "Module ./broken has finished with an error"),
    fail("empty", "\n"),
  ],
  backticks: [
    out("docs", header),
    out("docs", `\n${create("readme", { body: '"```sh\\necho hi\\n```"', note: '"a ```` b"' })}\n\nPlan: 1 to add, 0 to change, 0 to destroy.\n`),
  ],
  "unit-budget": [
    out("huge", header),
    out("huge", `\n${bigDiff("huge", 13000)}\nPlan: 1 to add, 0 to change, 0 to destroy.\n`),
    out("small", `\n${create("one", { a: "1" })}\n\nPlan: 1 to add, 0 to change, 0 to destroy.\n`),
  ],
  "total-budget": ["a", "b", "c", "d", "e", "f"].flatMap((u) => [
    out(`stack-${u}`, header),
    out(`stack-${u}`, `\n${bigDiff(u, 11000)}\nPlan: 1 to add, 0 to change, 0 to destroy.\n`),
  ]),
  "root-failure": [
    note(".", "Discovering units"),
    fail(".", "Error reading file at path /work/infra/root.hcl: ```unclosed``` block\n"),
    fail(".", "tofu invocation failed in ."),
    "❯❯ Run Summary  0 units  1s",
  ],
  "not-terragrunt": ["plain text from something that is not Terragrunt", "", "exit 1"],
  outside: [
    JSON.stringify({ level: "stdout", "working-dir": "/elsewhere/unit", msg: "\nNo changes.\n" }),
    JSON.stringify({ level: "stdout", msg: "record with no working dir" }),
    JSON.stringify({ level: "stdout", "working-dir": `${ROOT}/odd`, msg: 42 }),
  ],
};
