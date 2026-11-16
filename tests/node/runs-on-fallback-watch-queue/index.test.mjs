import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { InputError, watch } from '../../../actions/runs-on-fallback-watch-queue/lib/index.mjs';

function envFor(attempt = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-queue-'));
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: 'main' } }));
  return {
    GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: String(attempt),
    GITHUB_API_URL: 'https://api.test', GITHUB_EVENT_PATH: eventPath,
  };
}

const ok = (body, status = 200) => ({ ok: true, status, json: async () => body });

// Answers job reads from `statuses` in turn (an Error is a failed read), and
// every write with 204.
function fakeFetch(statuses, { name = 'verify', filler = 0 } = {}) {
  const calls = [];
  let read = 0;
  const fn = async (url, init) => {
    url = new URL(url);
    calls.push({ method: init.method, url, body: init.body && JSON.parse(init.body) });
    if (init.method !== 'GET') return ok(null, 204);
    const page = Number(url.searchParams.get('page'));
    const status = statuses[Math.min(read, statuses.length - 1)];
    if (status instanceof Error) { read += 1; throw status; }
    const others = Array.from({ length: filler }, (_, i) => ({ name: `job ${i}`, status: 'completed' }));
    // With filler, the target sits on page 2, after a full page of others.
    if (filler && page === 1) return ok({ jobs: others.slice(0, 100) });
    read += 1;
    return ok({ jobs: status === undefined ? [] : [{ name, status }] });
  };
  fn.calls = calls;
  return fn;
}

function run(statuses, overrides = {}, fetchOptions) {
  let clock = 0;
  const logs = [];
  const fetch = fakeFetch(statuses, fetchOptions);
  const promise = watch({
    jobName: 'verify', queueLimitSeconds: '60', maxRunAttempts: '3', requeueWorkflow: 'ci-requeue.yml',
    token: 't', env: envFor(), fetch,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    log: { info: (m) => logs.push(['info', m]), warning: (m) => logs.push(['warning', m]), error: (m) => logs.push(['error', m]) },
    ...overrides,
  });
  return { promise, fetch, logs };
}

const writes = (fetch) => fetch.calls.filter((c) => c.method !== 'GET').map((c) => c.url.pathname);

test('a job that gets a runner ends the watch without writing anything', async () => {
  const { promise, fetch } = run(['queued', 'in_progress']);
  assert.equal(await promise, 'started');
  assert.deepEqual(writes(fetch), []);
});

test('a job absent from this attempt ends the watch', async () => {
  const { promise, logs } = run([undefined]);
  assert.equal(await promise, 'started');
  assert.match(logs.at(-1)[1], /not in this attempt/);
});

test('a job still queued past the limit dispatches the requeue, then cancels', async () => {
  const { promise, fetch } = run(['queued']);
  assert.equal(await promise, 'requeued');
  assert.deepEqual(writes(fetch), ['/repos/o/r/actions/workflows/ci-requeue.yml/dispatches', '/repos/o/r/actions/runs/7/cancel']);
  const dispatch = fetch.calls.find((c) => c.url.pathname.endsWith('/dispatches'));
  assert.deepEqual(dispatch.body, { ref: 'main', inputs: { 'run-id': '7', 'run-attempt': '1' } });
});

test('the last attempt cancels without a requeue', async () => {
  const { promise, fetch } = run(['queued'], { env: envFor(3) });
  assert.equal(await promise, 'gave-up');
  assert.deepEqual(writes(fetch), ['/repos/o/r/actions/runs/7/cancel']);
});

test('approval and concurrency waits do not count toward the limit', async () => {
  const statuses = ['queued', 'queued', 'waiting', 'queued', 'queued', 'pending', 'queued', 'in_progress'];
  const { promise, fetch } = run(statuses, { queueLimitSeconds: '40' });
  assert.equal(await promise, 'started');
  assert.deepEqual(writes(fetch), []);
});

test('a failed read keeps watching instead of ending or cancelling', async () => {
  const { promise, fetch, logs } = run([new Error('boom'), new Error('boom'), 'in_progress']);
  assert.equal(await promise, 'started');
  assert.deepEqual(writes(fetch), []);
  assert.equal(logs.filter(([level]) => level === 'warning').length, 2);
});

test('a job on the second page of jobs is found', async () => {
  const { promise, fetch } = run(['in_progress'], {}, { filler: 100 });
  assert.equal(await promise, 'started');
  assert.deepEqual(fetch.calls.map((c) => c.url.searchParams.get('page')), ['1', '2']);
});

test('a job name with quotes is matched literally', async () => {
  const name = 'verify "linux"';
  const { promise } = run(['in_progress'], { jobName: name }, { name });
  assert.equal(await promise, 'started');
});

test('inputs that are not positive whole numbers are rejected', async () => {
  for (const bad of [{ queueLimitSeconds: '0' }, { maxRunAttempts: 'x' }, { requeueWorkflow: '' }, { jobName: '' }]) {
    await assert.rejects(run(['queued'], bad).promise, InputError);
  }
});
