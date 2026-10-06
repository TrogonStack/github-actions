import fs from "node:fs";
import path from "node:path";

import { getBooleanInput, info, setFailed } from "./core.mjs";

export const CONFIG_FILE = ".github/release-please-config.json";

const validationDefaults = Object.freeze(
  JSON.parse(fs.readFileSync(new URL("../validation-defaults.json", import.meta.url), "utf8")),
);
// Policy changes must not alter upstream's behavior for omitted settings.
const upstreamDefaults = Object.freeze({
  "bump-patch-for-minor-pre-major": false,
  draft: false,
  "draft-pull-request": false,
  prerelease: false,
  "include-v-in-tag": true,
});
const booleanFields = new Set([
  ...Object.keys(validationDefaults),
  "bump-minor-pre-major",
  "include-component-in-tag",
  "separate-pull-requests",
]);

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

  // A top-level value is the default release-please applies to every package,
  // but a package naming its own replaces it, even with an empty value.
  const fallback = config["initial-version"];
  const effective = (options) =>
    isPlainObject(options) && Object.hasOwn(options, "initial-version")
      ? options["initial-version"]
      : fallback;

  const missing = Object.entries(packages)
    .filter(([, options]) => !isSet(effective(options)))
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new InputError(
      `Every package in ${CONFIG_FILE} must set a non-empty \`initial-version\`, or leave it out and let the top level set one. Missing: ${missing.join(", ")}.`,
    );
  }

  return Object.entries(packages).map(
    ([name, options]) => `Package '${name}' starts at ${effective(options)}.`,
  );
}

function packageOptions(config) {
  if (!isPlainObject(config)) {
    throw new InputError(`${CONFIG_FILE} must be a JSON object.`);
  }
  if (!isPlainObject(config.packages) || Object.keys(config.packages).length === 0) {
    throw new InputError(`${CONFIG_FILE} has no \`packages\`, so there is nothing to release.`);
  }
  const packages = Object.entries(config.packages);
  for (const [name, options] of packages) {
    if (!isPlainObject(options)) {
      throw new InputError(`Package '${name}' in ${CONFIG_FILE} must be a JSON object.`);
    }
  }
  return packages;
}

function validateBooleans(options, location) {
  for (const key of booleanFields) {
    if (Object.hasOwn(options, key) && typeof options[key] !== "boolean") {
      throw new InputError(`${location} must set \`${key}\` to a boolean when provided.`);
    }
  }
}

export function validateReleaseDefaults(config) {
  const packages = packageOptions(config);
  validateBooleans(config, CONFIG_FILE);
  for (const [name, options] of packages) {
    const location = `Package '${name}' in ${CONFIG_FILE}`;
    validateBooleans(options, location);
    for (const [key, expected] of Object.entries(validationDefaults)) {
      const effective = Object.hasOwn(options, key)
        ? options[key]
        : Object.hasOwn(config, key) ? config[key] : upstreamDefaults[key];
      if (effective !== expected) {
        throw new InputError(`${location} must use \`${key}: ${expected}\` to match the shared release defaults.`);
      }
    }
  }
}

export function validateSignoff(config) {
  if (!isPlainObject(config)) {
    throw new InputError(`${CONFIG_FILE} must be a JSON object.`);
  }
  if (!isSet(config.signoff)) {
    throw new InputError(`${CONFIG_FILE} must set a non-empty string \`signoff\` for release commits.`);
  }
}

export function readConfig(workspace) {
  const file = path.join(workspace, CONFIG_FILE);

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new InputError(
      `Could not read ${CONFIG_FILE}. Check the repository out before this action.`,
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
    const requireInitialVersion = getBooleanInput("require_initial_version");
    const config = readConfig(process.env.GITHUB_WORKSPACE ?? process.cwd());
    validateReleaseDefaults(config);
    validateSignoff(config);
    if (!requireInitialVersion) {
      info("`require-initial-version` is false, so `initial-version` is not checked.");
      return;
    }

    const logs = validateInitialVersion(config);

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
