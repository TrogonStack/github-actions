import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { appendSummary, getInput, info, setFailed, setOutput, warning } from "./core.mjs";
import { render, streamLine } from "./report.mjs";

export const DEFAULT_REPORT_NAME = "terragrunt-report.md";

// Thrown for anything a caller can fix by editing their workflow, so main can
// report it as a GitHub error annotation rather than a stack trace.
export class InputError extends Error {}

function parseBoolean(name, value) {
  if (["true", "True", "TRUE"].includes(value)) return true;
  if (["false", "False", "FALSE"].includes(value)) return false;
  throw new InputError(`The \`${name}\` input must be \`true\` or \`false\`, got '${value}'.`);
}

export function readInputs({ cwd = process.cwd(), tmp = process.env.RUNNER_TEMP || os.tmpdir() } = {}) {
  const command = getInput("command", { trimWhitespace: false });
  if (command.trim() === "") {
    throw new InputError("The `command` input is required: it is what runs Terragrunt.");
  }

  const title = getInput("title");
  if (title === "") {
    throw new InputError("The `title` input is required: it heads the report.");
  }

  const workingDirectory = path.resolve(cwd, getInput("working-directory") || ".");
  if (!fs.statSync(workingDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new InputError(`The \`working-directory\` input names no directory: ${workingDirectory}`);
  }
  const rootInput = getInput("root");

  return {
    command,
    title,
    workingDirectory,
    // Unit paths are cut against the directory the run starts in unless told
    // otherwise, because that is the directory `--filter` is written against.
    root: rootInput === "" ? workingDirectory : path.resolve(cwd, rootInput),
    preamble: getInput("preamble"),
    reportPath: path.resolve(cwd, getInput("report-path") || path.join(tmp, DEFAULT_REPORT_NAME)),
    summary: parseBoolean("summary", getInput("summary") || "true"),
  };
}

function exitCodeOf(code, signal) {
  if (code !== null) return code;
  return 128 + (os.constants.signals[signal] ?? 0);
}

// The report reads Terragrunt's JSON log, so the format is decided here rather
// than left to every caller to remember. Setting it in the environment rather
// than as a flag reaches Terragrunt through whatever wraps it, a task runner or
// a secret loader, without the wrapper passing anything along. A custom format
// takes precedence over the JSON one, so it is removed rather than trusted to
// be absent.
export function childEnv(env = process.env) {
  const next = { ...env, TG_LOG_FORMAT: "json" };
  delete next.TG_LOG_CUSTOM_FORMAT;
  return next;
}

// Runs the command, streams its log as plain prefixed text while it runs, and
// renders the report once it has finished.
//
// The status that decides whether the step failed is the command's and nothing
// else's. A renderer that fails still fails the step, but with a warning naming
// it, so nobody reads a broken renderer as a broken plan.
export async function run({
  command,
  title,
  workingDirectory,
  root,
  preamble = "",
  reportPath,
  summary = true,
  env = process.env,
  write = (text) => process.stdout.write(text),
}) {
  const lines = [];
  let streamError;

  // Gone before anything runs, so the path never holds a report from an earlier
  // run in the job. A render that fails returns no path, but a later step
  // reading the default path directly would otherwise post the old report.
  fs.rmSync(reportPath, { force: true });

  // `exec 2>&1` inside the shell rather than two pipes merged here, because two
  // pipes are read in whatever order they become ready, and a diagnostic would
  // then land away from the unit that wrote it.
  //
  // Its own process group, so a cancellation reaches Terragrunt and tofu and not
  // only the shell. tofu releases the state lock when it is interrupted, and a
  // job killed without that leaves a lock the next run fails on until somebody
  // force-unlocks it.
  const child = spawn("bash", ["-eo", "pipefail", "-c", `exec 2>&1\n${command}`], {
    cwd: workingDirectory,
    env: childEnv(env),
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  });

  const forward = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone, which is what the signal was asking for.
    }
  };
  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) process.on(signal, forward);

  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    lines.push(line);
    let shown = line;
    try {
      shown = streamLine(line, root);
    } catch (error) {
      streamError ??= error;
    }
    write(`${shown}\n`);
  });

  let exitCode;
  try {
    // Both, because the last line of a log with no final newline is only
    // emitted once the reader sees the end of the stream.
    [exitCode] = await Promise.all([
      new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve(exitCodeOf(code, signal)));
      }),
      once(reader, "close"),
    ]);
  } finally {
    for (const signal of signals) process.off(signal, forward);
  }

  if (streamError !== undefined) {
    warning(`The run log could not be rendered as it streamed (${streamError.message}); lines were shown as they came.`);
    if (exitCode === 0) exitCode = 1;
  }

  let report;
  try {
    report = render({ lines, root, title, preamble });
  } catch (error) {
    warning(`The run finished with status ${exitCode} but rendering its report did not: ${error.message}`);
    return { exitCode: exitCode === 0 ? 1 : exitCode, reportPath: "" };
  }

  if (report.records === 0) {
    warning(
      "The command wrote no Terragrunt JSON log records, so the report is empty. Check that it runs Terragrunt and that nothing overrides TG_LOG_FORMAT.",
    );
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report.markdown, "utf8");

  if (summary) {
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendSummary(report.markdown);
    } else {
      info("No job summary to write to outside a runner; the report is only in the file.");
    }
  }

  return { exitCode, reportPath };
}

export async function main() {
  try {
    const { exitCode, reportPath } = await run(readInputs());
    setOutput("report-path", reportPath);
    setOutput("exit-code", String(exitCode));
    if (exitCode !== 0) {
      // Not `setFailed`: the command has already said what went wrong, in the
      // log and in the report, and an annotation repeating only the status would
      // be the one thing on the run page saying nothing.
      process.exitCode = exitCode;
    }
  } catch (thrown) {
    if (thrown instanceof InputError) {
      setFailed(thrown.message);
      return;
    }
    throw thrown;
  }
}
