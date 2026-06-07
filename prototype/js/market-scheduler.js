(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoStockMarketScheduler = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function deferred() {
    var out = {};
    out.promise = new Promise(function (resolve, reject) {
      out.resolve = resolve;
      out.reject = reject;
    });
    return out;
  }

  function priorityOf(task) {
    return Number(task && task.priority) || 0;
  }

  function createMarketRefreshScheduler(config) {
    var cfg = config || {};
    var runner = cfg.runner;
    if (typeof runner !== 'function') throw new Error('Market refresh scheduler requires a runner');
    var queue = [];
    var queuedByKey = {};
    var runningByKey = {};
    var running = null;
    var seq = 0;

    function snapshot() {
      return {
        running: running ? {
          id: running.id,
          kind: running.kind,
          priority: priorityOf(running),
          coalesceKey: running.coalesceKey
        } : null,
        queued: queue.map(function (task) {
          return {
            id: task.id,
            kind: task.kind,
            priority: priorityOf(task),
            coalesceKey: task.coalesceKey
          };
        })
      };
    }

    function sortQueue() {
      queue.sort(function (a, b) {
        var p = priorityOf(b) - priorityOf(a);
        return p || a.seq - b.seq;
      });
    }

    function settle(task, err, value) {
      task.waiters.forEach(function (waiter) {
        if (err) waiter.reject(err);
        else waiter.resolve(value);
      });
    }

    function drain() {
      if (running || !queue.length) return;
      running = queue.shift();
      if (running.coalesceKey) {
        delete queuedByKey[running.coalesceKey];
        runningByKey[running.coalesceKey] = running;
      }
      Promise.resolve()
        .then(function () { return runner(running); })
        .then(function (value) { settle(running, null, value); })
        .catch(function (err) { settle(running, err); })
        .finally(function () {
          if (running && running.coalesceKey) delete runningByKey[running.coalesceKey];
          running = null;
          drain();
        });
    }

    function enqueue(input) {
      var task = Object.assign({}, input || {});
      var waiter = deferred();
      if (cfg.shouldAccept && !cfg.shouldAccept(task)) {
        waiter.resolve(null);
        return waiter.promise;
      }
      task.id = task.id || (task.kind || 'market') + ':' + (++seq);
      task.seq = ++seq;
      task.priority = priorityOf(task);
      task.waiters = [waiter];
      if (task.coalesceKey) {
        if (queuedByKey[task.coalesceKey]) {
          queuedByKey[task.coalesceKey].waiters.push(waiter);
          return waiter.promise;
        }
        if (runningByKey[task.coalesceKey]) {
          runningByKey[task.coalesceKey].waiters.push(waiter);
          return waiter.promise;
        }
      }
      queue.push(task);
      if (task.coalesceKey) queuedByKey[task.coalesceKey] = task;
      sortQueue();
      drain();
      return waiter.promise;
    }

    return {
      enqueue: enqueue,
      snapshot: snapshot,
      size: function () { return queue.length + (running ? 1 : 0); },
      idle: function () { return !running && !queue.length; }
    };
  }

  return {
    createMarketRefreshScheduler: createMarketRefreshScheduler
  };
}));
