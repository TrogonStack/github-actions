import fs from "node:fs";

import { getInput, info, setFailed, setOutput } from "./core.mjs";

// One vocabulary across every repository is the reason this ships once rather
// than being copied, so `label-prefix` is for a collision with labels a
// repository already uses, not for taste.
export const DEFAULT_LABEL_PREFIX = "runs-on";

const POOL_NAME = /^[a-z0-9][a-z0-9-]*$/;

// No colon, because the colon is appended here. A prefix carrying one would
// produce `a::b` and match nothing anybody typed.
const LABEL_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Thrown for anything a caller can fix by editing their workflow, so main can
// report it as a GitHub error annotation rather than a stack trace.
export class InputError extends Error {}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Resolves a runner label without touching the environment, so the tests drive
// the code that ships rather than a copy of it.
export function resolve({ poolsJson, defaultPoolName, labelPrefix, eventLabels }) {
  const logs = [];

  const configured = labelPrefix || DEFAULT_LABEL_PREFIX;
  if (!LABEL_PREFIX.test(configured)) {
    throw new InputError(
      "The `label-prefix` input must be letters, digits, dots, dashes and underscores, with no colon: the colon is added for you.",
    );
  }
  const prefix = `${configured}:`;

  // Checked one at a time so a message names what is wrong rather than
  // reporting that something is.
  const parsed = parseJson(poolsJson);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    throw new InputError(
      "The `pools-json` input must be a JSON object mapping pool names to runner labels.",
    );
  }

  const pools = parsed.value;
  const names = Object.keys(pools);

  if (names.length === 0) {
    throw new InputError(
      "The `pools-json` input is an empty object, so there is nothing to schedule on.",
    );
  }

  if (!names.every((name) => POOL_NAME.test(name))) {
    throw new InputError(
      "Every pool name in `pools-json` must be lowercase letters, digits and dashes: it is half of a GitHub label.",
    );
  }

  if (!names.every((name) => typeof pools[name] === "string" && pools[name].length > 0)) {
    throw new InputError(
      "Every pool in `pools-json` must map to a single non-empty runner label.",
    );
  }

  // Both spellings of the vocabulary, for the messages below: pool names for the
  // inputs, prefixed labels for whoever is labelling a pull request.
  const known = names.join(", ");
  const askable = names.map((name) => prefix + name).join(", ");

  if (!defaultPoolName) {
    throw new InputError(
      `The \`default-pool-name\` input is required, and must name one of \`pools-json\`: ${known}.`,
    );
  }

  if (!Object.hasOwn(pools, defaultPoolName)) {
    throw new InputError(
      `The \`default-pool-name\` input '${defaultPoolName}' names no pool in \`pools-json\`. It knows: ${known}.`,
    );
  }

  let chosen;

  // The labels on the pull request behind this run. A run with no pull
  // request finds none and takes `default-pool-name`: `push`, `schedule`,
  // `workflow_run` and `workflow_dispatch` all carry no `pull_request`.
  //
  // One label decides, so two is a question this cannot answer. Matching in a
  // fixed order instead would make the answer depend on the order pools
  // happen to be written in.
  const asked = [...new Set(eventLabels.filter((name) => name.startsWith(prefix)))].sort();

  if (asked.length === 0) {
    chosen = defaultPoolName;
    logs.push(`No ${prefix}* label on this run, so the default pool '${chosen}' applies.`);
  } else if (asked.length === 1) {
    chosen = asked[0].slice(prefix.length);
    // A bare prefix is a label somebody half typed. Left to fall through it
    // would look exactly like asking for nothing.
    if (!chosen) {
      throw new InputError(
        `The label '${asked[0]}' names no pool. Ask for one of: ${askable}.`,
      );
    }
    logs.push(`Label '${asked[0]}' asks for pool '${chosen}'.`);
  } else {
    throw new InputError(
      `This run carries ${asked.length} ${prefix}* labels (${asked.join(" ")}). Leave exactly one, or none to take the default.`,
    );
  }

  // A label naming a pool that does not exist is a mistake, not a request for
  // the default. Falling back would schedule the run somewhere nobody asked for
  // and say nothing about it.
  if (!Object.hasOwn(pools, chosen)) {
    throw new InputError(`No pool named '${chosen}' in \`pools-json\`. It knows: ${askable}.`);
  }

  const runsOn = pools[chosen];
  logs.push(`Pool '${chosen}' resolves to runner label '${runsOn}'.`);

  return { runsOn, poolName: chosen, logs };
}

export function readEventLabels(path) {
  let event;
  try {
    event = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    throw new InputError(`Could not read the event payload at ${path}: ${error.message}`);
  }

  const labels = event?.pull_request?.labels;
  return Array.isArray(labels)
    ? labels.map((label) => label?.name).filter((name) => typeof name === "string")
    : [];
}

export function main() {
  try {
    const { runsOn, poolName, logs } = resolve({
      poolsJson: getInput("pools-json"),
      defaultPoolName: getInput("default-pool-name"),
      labelPrefix: getInput("label-prefix"),
      eventLabels: readEventLabels(process.env.GITHUB_EVENT_PATH),
    });

    for (const line of logs) {
      info(line);
    }

    setOutput("runs-on", runsOn);
    setOutput("pool-name", poolName);
  } catch (thrown) {
    if (thrown instanceof InputError) {
      setFailed(thrown.message);
      return;
    }
    throw thrown;
  }
}
