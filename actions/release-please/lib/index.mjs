import fs from "node:fs";
import path from "node:path";

import { getBooleanInput, info, setFailed } from "./core.mjs";

export const CONFIG_FILE = ".github/release-please-config.json";

// Thrown for anything a caller can fix in their repository, so main can report
// it as a GitHub error annotation rather than a stack trace.
export class InputError extends Error {}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSet(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Without `initial-version`, release-please picks the first version itself, so
// a new package ships whatever its defaults happen to be rather than what the
// repository meant.
export function validateInitialVersion(config) {
  if (!isPlainObject(config)) {
    throw new InputError(`${CONFIG_FILE} must be a JSON object.`);
  }

  const packages = config.packages;
  if (!isPlainObject(packages) || Object.keys(packages).length === 0) {
    throw new InputError(`${CONFIG_FILE} has no \`packages\`, so there is nothing to release.`);
  }

  // A top-level value is the default release-please applies to every package.
  const fallback = config["initial-version"];

  const missing = Object.entries(packages)
    .filter(([, options]) => !isSet(options?.["initial-version"]) && !isSet(fallback))
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new InputError(
      `Every package in ${CONFIG_FILE} must set \`initial-version\`, or the file must set one at the top level. Missing: ${missing.join(", ")}.`,
    );
  }

  return Object.keys(packages).map((name) => {
    const version = packages[name]?.["initial-version"] ?? fallback;
    return `Package '${name}' starts at ${version}.`;
  });
}

export function readConfig(workspace) {
  const file = path.join(workspace, CONFIG_FILE);

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new InputError(
      `Could not read ${CONFIG_FILE}. Check the repository out before this action, or set \`require-initial-version: false\`.`,
    );
  }

  try {
    return JSON.parse(text);
  } catch (thrown) {
    throw new InputError(`${CONFIG_FILE} is not valid JSON: ${thrown.message}`);
  }
}

export function main() {
  try {
    if (!getBooleanInput("require_initial_version")) {
      info("`require-initial-version` is false, so `initial-version` is not checked.");
      return;
    }

    const logs = validateInitialVersion(readConfig(process.env.GITHUB_WORKSPACE ?? process.cwd()));

    for (const line of logs) {
      info(line);
    }
  } catch (thrown) {
    if (thrown instanceof InputError || thrown instanceof TypeError) {
      setFailed(thrown.message);
      return;
    }
    throw thrown;
  }
}
