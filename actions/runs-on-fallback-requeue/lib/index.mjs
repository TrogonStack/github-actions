import { appendSummary, getInput, setFailed, setOutput } from "./core.mjs";
import { client } from "./github.mjs";

const POLL_MS = 15000;

export class InputError extends Error {}

function whole(name, text, pattern = /^[1-9][0-9]*$/) {
  if (!pattern.test(text ?? "")) {
    throw new InputError(`The \`${name}\` input must be a positive whole number, got '${text}'.`);
  }
  return Number(text);
}

// Decides without touching the process, so the tests drive the code that
// ships. Returns the reason the run was or was not requeued.
export async function requeue({
  runId,
  runAttempt,
  workflowPath,
  finishTimeoutSeconds,
  token,
  env = process.env,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  whole("run-id", runId);
  const attempt = whole("run-attempt", runAttempt);
  const timeoutMs = whole("finish-timeout-seconds", finishTimeoutSeconds) * 1000;
  if (!workflowPath) throw new InputError("The `workflow-path` input is required.");

  const repo = env.GITHUB_REPOSITORY;
  const api = client({ fetch, token, apiUrl: env.GITHUB_API_URL ?? "https://api.github.com" });

  // The watcher cancels the run right after dispatching this, and GitHub
  // reruns only a finished run. A failed read counts as not finished yet, so
  // one API error does not lose the requeue.
  const deadline = now() + timeoutMs;
  let run;
  for (;;) {
    run = await api.request("GET", `repos/${repo}/actions/runs/${runId}`).catch(() => null);
    if (run?.status === "completed") break;
    if (now() >= deadline) {
      throw new Error(`Run ${runId} did not finish within ${timeoutMs / 1000}s.`);
    }
    await sleep(POLL_MS);
  }

  // The API can report the path with an @ref suffix.
  const path = String(run.path ?? "").split("@")[0];
  if (path !== workflowPath) {
    throw new InputError(`Run ${runId} is ${path}, not ${workflowPath}.`);
  }
  // Another request already requeued the attempt that asked for this one, so
  // rerunning now would add an attempt the watcher did not ask for.
  if (run.run_attempt !== attempt) return "stale-attempt";
  if (run.conclusion !== "cancelled") return "not-cancelled";

  // A newer run of the same branch, repository and event has replaced this
  // one, and running this one again could cancel it through a concurrency
  // group. A fork's branch of the same name does not count. run_number orders
  // runs of one workflow even when they share a creation second, and a rerun
  // keeps it.
  const headRepo = String(run.head_repository?.full_name ?? "").toLowerCase();
  let newer = false;
  await api.eachPage(
    `repos/${repo}/actions/workflows/${run.workflow_id}/runs`,
    "workflow_runs",
    { branch: run.head_branch, event: run.event },
    (runs) => {
      newer = runs.some((other) =>
        other?.run_number > run.run_number
        && String(other.head_repository?.full_name ?? "").toLowerCase() === headRepo);
      return newer;
    },
  );
  if (newer) return "replaced-by-newer-run";

  await api.request("POST", `repos/${repo}/actions/runs/${runId}/rerun`);
  return "requeued";
}

export async function main() {
  try {
    const runId = getInput("run-id");
    const reason = await requeue({
      runId,
      runAttempt: getInput("run-attempt"),
      workflowPath: getInput("workflow-path"),
      finishTimeoutSeconds: getInput("finish-timeout-seconds"),
      token: getInput("github-token"),
    });
    setOutput("reason", reason);
    appendSummary(`Run ${runId}: ${reason}`);
  } catch (thrown) {
    if (thrown instanceof InputError) {
      setFailed(thrown.message);
      return;
    }
    throw thrown;
  }
}
