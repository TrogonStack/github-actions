// A stand-in for the functions this action uses from `@actions/core`, carrying
// their names and their behaviour. The package itself is ESM-only and reaches
// `undici` through `@actions/http-client`, so depending on it would mean a
// bundler and a committed `dist/`, and the tests would then exercise something
// other than the file the runner executes.

import { EOL } from "node:os";

// The runner uppercases an input name and replaces spaces, and nothing else. A
// composite action sets these variables itself, so it picks the spelling.
export function getInput(name, options = {}) {
  const value = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "";

  if (options.required && !value) {
    throw new Error(`Input required and not supplied: ${name}`);
  }

  return options.trimWhitespace === false ? value : value.trim();
}

const TRUE_VALUES = ["true", "True", "TRUE"];
const FALSE_VALUES = ["false", "False", "FALSE"];

export function getBooleanInput(name, options = {}) {
  const value = getInput(name, options);

  if (TRUE_VALUES.includes(value)) {
    return true;
  }

  if (FALSE_VALUES.includes(value)) {
    return false;
  }

  throw new TypeError(
    `Input does not meet YAML 1.2 "Core Schema" specification: ${name}\n` +
      "Support boolean input list: `true | True | TRUE | false | False | FALSE`",
  );
}

// Workflow commands end at a newline, so a message carrying one would close the
// annotation and log the remainder as its own line.
function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function info(message) {
  process.stdout.write(`${message}${EOL}`);
}

export function error(message) {
  process.stdout.write(`::error::${escapeData(message)}${EOL}`);
}

export function setFailed(message) {
  // Not `process.exit`, which can truncate output still buffered on stdout.
  process.exitCode = 1;
  error(message);
}
