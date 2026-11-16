import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError, requeue } from '../../../actions/runs-on-fallback-requeue/lib/index.mjs';

const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: 'https://api.test' };
const ok = (body, status = 200) => ({ ok: true, status, json: async () => body });

const baseRun = {
  status: 'completed', conclusion: 'cancelled', run_attempt: 1, run_number: 10,
  path: '.github/workflows/ci.yml@refs/heads/main', workflow_id: 5,
  head_branch: 'feature/a+b', event: 'pull_request', head_repository: { full_name: 'o/r' },
};

// `runs` answers successive reads of the run (an Error is a failed read);
// `pages` answers the workflow's run listing page by page.
function fakeFetch({ runs = [baseRun], pages = [[]] } = {}) {
  const calls = [];
  let read = 0;
  const fn = async (url, init) => {
    url = new URL(url);
    calls.push({ method: init.method, url });
    if (init.method !== 'GET') return ok(null, 201);
    if (url.pathname.endsWith('/runs')) {
      return ok({ workflow_runs: pages[Number(url.searchParams.get('page')) - 1] ?? [] });
    }
    const run = runs[Math.min(read, runs.length - 1)];
    read += 1;
    if (run instanceof Error) throw run;
    return ok(run);
  };
  fn.calls = calls;
  return fn;
}

function call(fetchOptions, overrides = {}) {
  let clock = 0;
  const fetch = fakeFetch(fetchOptions);
  const promise = requeue({
    runId: '42', runAttempt: '1', workflowPath: '.github/workflows/ci.yml', finishTimeoutSeconds: '60',
    token: 't', env, fetch, sleep: async (ms) => { clock += ms; }, now: () => clock, ...overrides,
  });
  return { promise, fetch };
}

const reran = (fetch) => fetch.calls.some((c) => c.method === 'POST' && c.url.pathname === '/repos/o/r/actions/runs/42/rerun');
const other = (run_number, full_name = 'o/r') => ({ run_number, head_repository: { full_name } });

test('a cancelled run with no newer run is rerun, after it finishes cancelling', async () => {
  const { promise, fetch } = call({ runs: [{ status: 'in_progress' }, new Error('boom'), baseRun] });
  assert.equal(await promise, 'requeued');
  assert.ok(reran(fetch));
});

test('the branch query is encoded rather than read as a space', async () => {
  const { promise, fetch } = call();
  await promise;
  const list = fetch.calls.find((c) => c.url.pathname === '/repos/o/r/actions/workflows/5/runs');
  assert.equal(list.url.searchParams.get('branch'), 'feature/a+b');
  assert.equal(list.url.searchParams.get('event'), 'pull_request');
});

test('a run that finished some other way is left alone', async () => {
  const { promise, fetch } = call({ runs: [{ ...baseRun, conclusion: 'success' }] });
  assert.equal(await promise, 'not-cancelled');
  assert.ok(!reran(fetch));
});

test('a run already on another attempt is left alone', async () => {
  const { promise, fetch } = call({ runs: [{ ...baseRun, run_attempt: 2 }] });
  assert.equal(await promise, 'stale-attempt');
  assert.ok(!reran(fetch));
});

test('a newer run of the same repository, even on a later page, replaces it', async () => {
  const forks = Array.from({ length: 100 }, (_, i) => other(20 + i, `fork${i}/r`));
  const { promise, fetch } = call({ pages: [forks, [other(11)]] });
  assert.equal(await promise, 'replaced-by-newer-run');
  assert.ok(!reran(fetch));
});

test('a fork run of the same branch name, or an older run, does not replace it', async () => {
  const { promise, fetch } = call({ pages: [[other(11, 'fork/r'), other(9)]] });
  assert.equal(await promise, 'requeued');
  assert.ok(reran(fetch));
});

test('a run of another workflow is refused', async () => {
  const { promise } = call({ runs: [{ ...baseRun, path: '.github/workflows/deploy.yml' }] });
  await assert.rejects(promise, InputError);
});

test('a run that never finishes cancelling fails after the timeout', async () => {
  const { promise, fetch } = call({ runs: [{ status: 'in_progress' }] });
  await assert.rejects(promise, /did not finish within 60s/);
  assert.ok(!reran(fetch));
});

test('inputs that are not positive whole numbers are rejected', async () => {
  for (const bad of [{ runId: 'x' }, { runAttempt: '0' }, { finishTimeoutSeconds: '' }, { workflowPath: '' }]) {
    await assert.rejects(call({}, bad).promise, InputError);
  }
});
