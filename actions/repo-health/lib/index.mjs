import fs from "node:fs";
import path from "node:path";

import { error, getInput, info, setFailed, setOutput, warning } from "./core.mjs";

// Thrown for anything a caller can fix by editing their workflow, so main can
// report it as a GitHub error annotation rather than a stack trace.
export class InputError extends Error {}

// The keys CFF 1.2.0 requires. Checked by top-level key rather than against the
// full schema, because a schema validator is a dependency, and a dependency
// here means a bundler and a committed `dist/`.
const CITATION_KEYS = ["cff-version", "message", "title", "authors"];

// YAML allows a key in quotes, so `"title": Widgets` names `title` too.
const TOP_LEVEL_KEY = /^(["']?)([A-Za-z][A-Za-z0-9-]*)\1\s*:/;

function checkCitation(directory) {
  // GitHub reads the file from the root under this exact name, and a
  // case-insensitive filesystem would accept `citation.cff` that GitHub ignores.
  if (!fs.readdirSync(directory).includes("CITATION.cff")) {
    return [
      "No CITATION.cff at the repository root. GitHub reads it from there to offer \"Cite this repository\". See https://citation-file-format.github.io.",
    ];
  }

  const keys = new Set(
    fs
      .readFileSync(path.join(directory, "CITATION.cff"), "utf8")
      .split(/\r?\n/)
      .map((line) => TOP_LEVEL_KEY.exec(line)?.[2])
      .filter(Boolean),
  );
  const missing = CITATION_KEYS.filter((key) => !keys.has(key));
  if (missing.length > 0) {
    return [`CITATION.cff is missing the required ${missing.map((key) => `\`${key}\``).join(", ")}.`];
  }
  return [];
}

// Every check runs unless its own `<check>-skip` input says why not, so a new
// check reaches every consumer on their next upgrade instead of waiting to be
// switched on. Options are inputs per check, rather than one shared list, so
// the runner warns about a misspelled one, and the check it meant to skip
// still runs and fails.
export const CHECKS = [{ id: "citation-cff", run: checkCitation }];

// A bare boolean says the check is off without saying why, which is the one
// thing a waiver has to carry.
const NOT_A_REASON = /^(true|false|yes|no|on|off|1|0)$/i;

export function skipReason(id, value) {
  if (value === "") return undefined;
  if (NOT_A_REASON.test(value)) {
    throw new InputError(`\`${id}-skip\` is \`${value}\`. Write the reason the check is skipped instead.`);
  }
  return value;
}

// A skipped check still runs, so a waiver that is no longer needed is reported
// rather than left to hide the next regression.
export function run({ inputs }) {
  const reasons = new Map(CHECKS.map((check) => [check.id, skipReason(check.id, inputs.checks[check.id]?.skip ?? "")]));

  if (!fs.existsSync(inputs.directory) || !fs.statSync(inputs.directory).isDirectory()) {
    throw new InputError(
      `No directory at ${inputs.directory}. Check the repository out before this step, or point \`directory\` at it.`,
    );
  }

  return CHECKS.map((check) => ({
    id: check.id,
    problems: check.run(inputs.directory),
    skipReason: reasons.get(check.id),
  }));
}

export function main() {
  try {
    const results = run({
      inputs: {
        directory: getInput("directory"),
        checks: Object.fromEntries(CHECKS.map((check) => [check.id, { skip: getInput(`${check.id}-skip`) }])),
      },
    });

    const failed = [];
    for (const { id, problems, skipReason: reason } of results) {
      if (reason !== undefined) {
        if (problems.length === 0) {
          warning(`${id} is skipped but passes. Remove \`${id}-skip\`.`);
        } else {
          warning(`${id} skipped: ${reason}`);
        }
        continue;
      }

      if (problems.length === 0) {
        info(`${id} passed.`);
        continue;
      }

      failed.push(id);
      for (const problem of problems) error(`${id}: ${problem}`);
    }

    setOutput("failed", JSON.stringify(failed));

    if (failed.length > 0) {
      setFailed(
        `Failed: ${failed.join(", ")}. Fix them, or skip one by setting its \`<check>-skip\` input to the reason.`,
      );
    }
  } catch (thrown) {
    setFailed(thrown.message);
  }
}
