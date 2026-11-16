import fs from "node:fs";

import { error, getInput, info, setFailed, warning } from "./core.mjs";
import { client } from "./github.mjs";

const POLL_MS = 20000;

// Only `queued` is a wait for a runner. `waiting` is a deployment approval and
// `pending` or `requested` a concurrency or dependency wait, none of which a
// different runner would shorten, so they are watched without the clock.
const NOT_RUNNER_WAITS = new Set(["waiting", "pending", "requested"]);

export class InputError extends Error {}

function positive(name, text) {
  if (!/^[1-9][0-9]*$/.test(text ?? "")) {
    throw new InputError(`The \`${name}\` input must be a positive whole number, got '${text}'.`);
  }
  return Number(text);
}

function readEvent(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Watches without touching the process, so the tests drive the code that
// ships. Acts only on a status it read: a failed read keeps watching rather
// than end the watch or cancel a job that may have started, and the limit is
// checked right after a read, so the cancel follows a current `queued`.
export async function watch({
  jobName,
  queueLimitSeconds,
  maxRunAttempts,
  requeueWorkflow,
  token,
  env = process.env,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  log = { info, warning, error },
}) {
  if (!jobName) throw new InputError("The `job-name` input is required.");
  if (!requeueWorkflow) throw new InputError("The `requeue-workflow` input is required.");
  const limitMs = positive("queue-limit-seconds", queueLimitSeconds) * 1000;
  const maxAttempts = positive("max-run-attempts", maxRunAttempts);

  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  const api = client({ fetch, token, apiUrl: env.GITHUB_API_URL ?? "https://api.github.com" });

  let queuedSince = null;
  for (;;) {
    let status;
    try {
      status = null;
      await api.eachPage(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs", {}, (jobs) => {
        const job = jobs.find((candidate) => candidate?.name === jobName);
        if (job) status = job.status;
        return Boolean(job);
      });
    } catch (thrown) {
      log.warning(`Could not read ${jobName}'s status (${thrown.message}); trying again.`);
      await sleep(POLL_MS);
      continue;
    }

    if (status === "queued") {
      queuedSince ??= now();
      if (now() - queuedSince >= limitMs) break;
    } else if (NOT_RUNNER_WAITS.has(status)) {
      queuedSince = null;
    } else {
      log.info(`${jobName} is ${status ?? "not in this attempt"}; nothing to watch.`);
      return "started";
    }
    await sleep(POLL_MS);
  }

  const seconds = limitMs / 1000;
  let outcome;
  if (attempt >= maxAttempts) {
    log.error(`${jobName} waited ${seconds}s for a runner on attempt ${attempt} of ${maxAttempts}; cancelling without another attempt. Check that the self-hosted runners are online.`);
    outcome = "gave-up";
  } else {
    log.warning(`${jobName} waited ${seconds}s for a runner; requeueing the run so it chooses a runner again.`);
    const ref = readEvent(env.GITHUB_EVENT_PATH)?.repository?.default_branch;
    if (!ref) throw new Error("The event payload does not name the repository's default branch.");
    await api.request("POST", `repos/${repo}/actions/workflows/${encodeURIComponent(requeueWorkflow)}/dispatches`, {
      body: { ref, inputs: { "run-id": String(runId), "run-attempt": String(attempt) } },
    });
    outcome = "requeued";
  }
  await api.request("POST", `repos/${repo}/actions/runs/${runId}/cancel`);
  return outcome;
}

export async function main() {
  try {
    await watch({
      jobName: getInput("job-name"),
      queueLimitSeconds: getInput("queue-limit-seconds"),
      maxRunAttempts: getInput("max-run-attempts"),
      requeueWorkflow: getInput("requeue-workflow"),
      token: getInput("github-token"),
    });
  } catch (thrown) {
    if (thrown instanceof InputError) {
      setFailed(thrown.message);
      return;
    }
    throw thrown;
  }
}
