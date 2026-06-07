const assert = require('assert');
const { createMarketRefreshScheduler } = require('../prototype/js/market-scheduler.js');

function deferred() {
  const out = {};
  out.promise = new Promise((resolve, reject) => {
    out.resolve = resolve;
    out.reject = reject;
  });
  return out;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testPriorityInsert() {
  const holds = {};
  const calls = [];
  const scheduler = createMarketRefreshScheduler({
    runner: (task) => {
      calls.push(task.id);
      if (!task.hold) return task.id;
      holds[task.id] = deferred();
      return holds[task.id].promise.then(() => task.id);
    },
  });
  const first = scheduler.enqueue({ id: 'running-low', priority: 1, hold: true, coalesceKey: 'running-low' });
  await delay(0);
  const queuedLow = scheduler.enqueue({ id: 'queued-low', priority: 1, coalesceKey: 'queued-low' });
  const queuedHigh = scheduler.enqueue({ id: 'queued-high', priority: 90, coalesceKey: 'queued-high' });
  assert.deepStrictEqual(scheduler.snapshot().queued.map((item) => item.id), ['queued-high', 'queued-low']);
  holds['running-low'].resolve();
  assert.deepStrictEqual(await Promise.all([first, queuedHigh, queuedLow]), ['running-low', 'queued-high', 'queued-low']);
  assert.deepStrictEqual(calls, ['running-low', 'queued-high', 'queued-low']);
}

async function testQueuedCoalescing() {
  const holds = {};
  const calls = [];
  const scheduler = createMarketRefreshScheduler({
    runner: (task) => {
      calls.push(task.id);
      if (!task.hold) return task.id + ':value';
      holds[task.id] = deferred();
      return holds[task.id].promise.then(() => task.id + ':value');
    },
  });
  const blocker = scheduler.enqueue({ id: 'blocker', priority: 1, hold: true, coalesceKey: 'blocker' });
  await delay(0);
  const a = scheduler.enqueue({ id: 'dup-a', priority: 10, coalesceKey: 'dup' });
  const b = scheduler.enqueue({ id: 'dup-b', priority: 99, coalesceKey: 'dup' });
  assert.deepStrictEqual(scheduler.snapshot().queued.map((item) => item.id), ['dup-a']);
  holds.blocker.resolve();
  assert.strictEqual(await blocker, 'blocker:value');
  assert.deepStrictEqual(await Promise.all([a, b]), ['dup-a:value', 'dup-a:value']);
  assert.deepStrictEqual(calls, ['blocker', 'dup-a']);
}

async function testRunningCoalescing() {
  const holds = {};
  const calls = [];
  const scheduler = createMarketRefreshScheduler({
    runner: (task) => {
      calls.push(task.id);
      holds[task.id] = deferred();
      return holds[task.id].promise.then(() => task.id + ':value');
    },
  });
  const a = scheduler.enqueue({ id: 'running', priority: 10, coalesceKey: 'same' });
  await delay(0);
  const b = scheduler.enqueue({ id: 'running-duplicate', priority: 99, coalesceKey: 'same' });
  assert.strictEqual(scheduler.snapshot().queued.length, 0);
  holds.running.resolve();
  assert.deepStrictEqual(await Promise.all([a, b]), ['running:value', 'running:value']);
  assert.deepStrictEqual(calls, ['running']);
}

async function testShouldAcceptSkip() {
  const calls = [];
  const scheduler = createMarketRefreshScheduler({
    shouldAccept: (task) => !task.auto,
    runner: (task) => {
      calls.push(task.id);
      return task.id;
    },
  });
  assert.strictEqual(await scheduler.enqueue({ id: 'auto', auto: true, priority: 10 }), null);
  assert.strictEqual(await scheduler.enqueue({ id: 'manual', priority: 10 }), 'manual');
  assert.deepStrictEqual(calls, ['manual']);
}

async function testFifoAtSamePriority() {
  const calls = [];
  const scheduler = createMarketRefreshScheduler({
    runner: (task) => {
      calls.push(task.id);
      return task.id;
    },
  });
  assert.deepStrictEqual(await Promise.all([
    scheduler.enqueue({ id: 'a', priority: 5, coalesceKey: 'a' }),
    scheduler.enqueue({ id: 'b', priority: 5, coalesceKey: 'b' }),
    scheduler.enqueue({ id: 'c', priority: 5, coalesceKey: 'c' }),
  ]), ['a', 'b', 'c']);
  assert.deepStrictEqual(calls, ['a', 'b', 'c']);
}

(async () => {
  await testPriorityInsert();
  await testQueuedCoalescing();
  await testRunningCoalescing();
  await testShouldAcceptSkip();
  await testFifoAtSamePriority();
  console.log('market-scheduler smoke ok');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
