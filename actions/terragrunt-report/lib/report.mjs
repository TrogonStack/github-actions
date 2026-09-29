// Turns a Terragrunt run into something a person reads.
//
// Terragrunt wraps every line tofu writes in a log record of its own: a
// timestamp, the stream name, the unit prefix and `tofu:`, each of them
// coloured. None of that renders as colour inside a fenced block in a pull
// request comment, so a plan arrives as a wall of escape codes with the diff
// pushed into the right-hand third of every line, and `run --all` interleaves
// the units besides. That is what makes a raw log unreadable as a comment,
// rather than the size of the plan.
//
// The JSON log format is the same information without the presentation: one
// object per line, the unit in `working-dir`, the stream in `level`, the text
// in `msg`. Everything here reads that.
//
// `stdout` is tofu's own stdout, and only that carries a plan or an apply.
// `info` is Terragrunt narrating plus tofu's init chatter, and `error` is the
// failure text. Terragrunt orders `stdout` above `warn`, so TG_LOG_LEVEL=warn
// still lets every record this reads through.
//
// Terragrunt's closing run summary is printed raw rather than as a record, so
// every reader here has to tolerate a line that is not JSON.

// GitHub rejects a comment body over 65536 characters and a single plan can
// pass that on its own, so the budget is spent per unit rather than on the run
// as a whole: one large unit cannot push every other unit's diff out of the
// comment. The step summary is capped separately and far higher (1MB), and the
// run log is never truncated at all, so both remain the place to read the whole
// thing.
export const UNIT_BUDGET = 12000;
export const COMMENT_BUDGET = 55000;

const NOOP_VERDICTS = new Set([
  "no changes",
  "no output",
  "0 to add, 0 to change, 0 to destroy",
  "0 added, 0 changed, 0 destroyed",
]);

export function parseRecord(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

// Terragrunt reports a unit by its absolute working directory, and this gives
// back the path a person would type at `--filter`. A directory outside the root
// is left whole rather than guessed at: a wrong short name is worse than a long
// right one.
export function unitOf(record, root) {
  const dir = typeof record["working-dir"] === "string" ? record["working-dir"] : "";
  if (dir === "") return "";
  if (root !== "" && dir.startsWith(`${root}/`)) return dir.slice(root.length + 1);
  if (dir === root) return ".";
  return dir;
}

// One trailing newline is the record's own terminator, not a blank line in the
// output, and an empty message is no lines at all rather than one empty one.
export function linesOf(record) {
  const msg = typeof record.msg === "string" ? record.msg : "";
  const text = msg.endsWith("\n") ? msg.slice(0, -1) : msg;
  return text === "" ? [] : text.split("\n");
}

// The run log a person opens while the job is still going: each line of a
// record tagged with its unit, and anything that is not a record as it came.
export function streamLine(line, root) {
  const record = parseRecord(line);
  if (record === null) return line;
  const unit = unitOf(record, root);
  const tag = unit === "" ? "" : `[${unit}] `;
  return linesOf(record)
    .map((text) => tag + text)
    .join("\n");
}

// A string's length and prefix in characters, not UTF-16 code units, so an
// emoji in a plan costs what it costs GitHub.
function charLength(text) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function charSlice(text, end) {
  return Array.from(text).slice(0, end).join("");
}

function trimTrailingNewlines(text) {
  return text.replace(/\n+$/, "");
}

// What a unit did, with the lines that are the same under every unit removed.
//
// The trailer tofu prints when no -out file was given is eight identical lines
// per unit. The state lock and the refresh of every existing resource are the
// larger share: on a unit holding a hundred resources they are a hundred lines
// above the diff, and they report what the run read, not what it changes.
//
// Nothing an apply does is dropped. Creating, Modifying and Destroying stay,
// because on an apply those lines are the record of what actually happened and
// of where it stopped if it stopped.
export function trim(text) {
  const out = [];
  let pending = false;
  let printed = false;
  for (const line of text.split("\n")) {
    if (/^Note: You didn.t use the -out option/.test(line)) break;
    if (/^(Acquiring|Releasing) state lock\./.test(line)) continue;
    if (/: Refreshing state\.\.\./.test(line)) continue;
    if (/: Reading\.\.\.$/.test(line)) continue;
    if (/: Read complete after /.test(line)) continue;
    if (/^\s*$/.test(line) || /^─+$/.test(line)) {
      pending = true;
      continue;
    }
    if (pending && printed) out.push("");
    pending = false;
    printed = true;
    out.push(line);
  }
  return out.join("\n");
}

// What is left of a unit's error records once the lines that say only that it
// failed are gone. Terragrunt reports a failure several times over, and for a
// unit that failed only because something it depends on did, it says nothing
// else. A collapsed block holding one line saying the unit failed, under a row
// already saying so, is worse than no block.
//
// Empty output therefore means there is nothing to show, not that the unit
// succeeded.
export function stripWrapper(text) {
  const kept = text
    .split("\n")
    .filter(
      (line) =>
        !/^tofu invocation failed in /.test(line) &&
        !/^Module .* has finished with an error$/.test(line) &&
        !/^Dependency .* just finished with an error/.test(line) &&
        !/^Unable to determine underlying exit code/.test(line),
    );
  const first = kept.findIndex((line) => /\S/.test(line));
  return first === -1 ? "" : trimTrailingNewlines(kept.slice(first).join("\n"));
}

// The one line that says what a unit did, reduced to what fits a table cell.
//
// An apply prints its plan first and its result last, so both lines are in the
// body and only the last one is true. Reading "Plan:" there would report an
// apply by what it intended rather than by what it did, and a partial apply is
// exactly when those differ.
export function verdict(body) {
  const lines = body.split("\n");
  let line = lines.filter((l) => /^Apply complete! Resources:/.test(l)).at(-1);
  if (line === undefined) line = lines.find((l) => /^Plan: [0-9]/.test(l));
  if (line !== undefined) {
    if (line.endsWith(".")) line = line.slice(0, -1);
    if (line.startsWith("Plan: ")) line = line.slice("Plan: ".length);
    if (line.startsWith("Apply complete! Resources: ")) {
      line = line.slice("Apply complete! Resources: ".length);
    }
    return line;
  }
  if (body.includes("Changes to Outputs")) return "outputs only";
  if (lines.some((l) => /^No changes\./.test(l))) return "no changes";
  return "no output";
}

// A fence longer than the longest run of backticks in what it has to hold. A
// plan diff is arbitrary strings, and three backticks in one would otherwise
// close the fence early and spill the rest of the plan into the comment as
// markdown.
export function fence(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

// Whether a verdict means the unit left the provider as it found it. Those
// units are a table row and nothing more, which is the whole reason the report
// is shorter than the log: on a change touching one stack, the converged units
// are almost all of them.
export function isNoop(value) {
  return NOOP_VERDICTS.has(value);
}

function recordsOf(lines) {
  const records = [];
  for (const line of lines) {
    const record = parseRecord(line);
    if (record !== null) records.push(record);
  }
  return records;
}

// Every unit that said anything tofu wrote, which is stdout, stderr and error
// and not `info`. A unit whose plan failed before tofu produced any output has
// only `error` records, and leaving it out of the table would report a failed
// run as a table of units that all converged.
//
// `.` is dropped because it is not a unit. When a run fails, Terragrunt writes
// a closing record against the run root collecting every unit's failure into
// one block, and taking it for a unit would put a verbatim copy of every
// diagnostic in the report a second time, as the largest block in it.
function unitsOf(records, root) {
  const units = new Set();
  for (const record of records) {
    if (!["stdout", "stderr", "error"].includes(record.level)) continue;
    const unit = unitOf(record, root);
    if (unit !== "" && unit !== ".") units.add(unit);
  }
  // Code point order, so the table reads the same wherever it is rendered.
  return [...units].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function unitStream(records, root, unit, level) {
  return records
    .filter((record) => record.level === level && unitOf(record, root) === unit)
    .flatMap(linesOf)
    .join("\n");
}

// A table of every unit in the run, then a collapsed diff for each unit that
// actually changed something.
export function render({ lines, root, title, preamble = "" }) {
  const records = recordsOf(lines);
  let rows = "";
  let quiet = "";
  let details = "";
  let spent = 0;
  let budgetHit = false;
  let failed = false;

  for (const unit of unitsOf(records, root)) {
    // The two streams are trimmed apart and joined afterwards rather than
    // trimmed together. The trailer rule cuts from its match to the end of what
    // it is given, and a unit that planned cleanly and warned on stderr would
    // lose the warning to the plan's own trailer.
    let body = trim(unitStream(records, root, unit, "stdout"));
    let unitVerdict = verdict(body);

    const failure = trimTrailingNewlines(unitStream(records, root, unit, "error"));
    if (failure !== "") {
      unitVerdict = "failed";
      failed = true;
      // tofu writes its diagnostics to stderr and Terragrunt then repeats them
      // inside an error record of its own. Preferring stderr keeps the text at
      // tofu's own indentation; the record is the fallback for a unit that
      // failed before tofu wrote anything, where it is the only account of what
      // went wrong.
      let diagnostics = trim(unitStream(records, root, unit, "stderr"));
      if (diagnostics === "") diagnostics = stripWrapper(failure);
      if (diagnostics !== "") {
        if (body !== "") body += "\n\n";
        body += diagnostics;
      }
    }

    // A converged unit is still listed, in the collapsed table at the end. A
    // unit missing from the report and a unit that converged are not the same
    // thing, and a reviewer cannot tell them apart.
    if (isNoop(unitVerdict)) {
      quiet += `| \`${unit}\` | ${unitVerdict} |\n`;
      continue;
    }

    rows += `| \`${unit}\` | ${unitVerdict} |\n`;
    // A unit that failed on a dependency has a row and nothing else to say.
    if (body === "") continue;

    if (charLength(body) > UNIT_BUDGET) {
      body = `${charSlice(body, UNIT_BUDGET)}\n... this unit is longer than the comment allows; read it in the job summary`;
    }
    const size = charLength(body);
    if (spent + size > COMMENT_BUDGET) {
      budgetHit = true;
      continue;
    }
    spent += size;

    const f = fence(body);
    details += `<details><summary><code>${unit}</code> · ${unitVerdict}</summary>\n\n`;
    details += `${f}text\n${body}\n${f}\n\n`;
    details += "</details>\n\n";
  }

  let out = `### ${title}\n\n`;
  if (preamble !== "") out += `${preamble}\n\n`;

  if (failed) {
    out +=
      "**Failed.** A unit marked `failed` with nothing collapsed under it was stopped by one that has something collapsed under it.\n\n";
  }

  if (rows !== "") {
    out += `| Unit | Change |\n| --- | --- |\n${rows}\n`;
  } else if (quiet !== "") {
    out += "Every unit matches its configuration.\n\n";
  } else {
    // No unit to attribute anything to, so the run itself failed before any
    // unit started: a root configuration Terragrunt could not parse, or a
    // filter it refused. The run root's own error records are then the only
    // account of what went wrong, and a report without them would say nothing
    // but that nothing happened.
    const rootFailure = stripWrapper(
      trimTrailingNewlines(
        records
          .filter((record) => record.level === "error" && ["", "."].includes(unitOf(record, root)))
          .flatMap(linesOf)
          .join("\n"),
      ),
    );
    if (rootFailure !== "") {
      const f = fence(rootFailure);
      out += `**Failed.**\n\n${f}text\n${rootFailure}\n${f}\n\n`;
    } else {
      out += "No unit produced any output. The run stopped before tofu started.\n\n";
    }
  }

  out += details;
  if (budgetHit) {
    out += "_Some units are left out of this comment for length. The job summary has all of them._\n\n";
  }

  if (quiet !== "") {
    out += "<details><summary>Unchanged</summary>\n\n";
    out += `| Unit | Change |\n| --- | --- |\n${quiet}\n`;
    out += "</details>\n";
  }

  return { markdown: out, records: records.length };
}
