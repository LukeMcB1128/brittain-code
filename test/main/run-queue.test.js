const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { enqueue, dequeue, peek, clear, cancel, queuePath, DEFAULT_MAX_AGE_MS, MAX_ENTRIES } = require('../../src/main/run-queue');

function withDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-queue-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const request = (over = {}) => ({ goal: 'run the tests', cwd: '/project', policy: 'nightly', ...over });

test('a run queued while another is in flight is kept, not lost', () => {
  withDir((dir) => {
    const queued = enqueue(dir, request());
    assert.equal(queued.ok, true);
    assert.equal(queued.depth, 1);
    assert.equal(dequeue(dir).entry.goal, 'run the tests');
  });
});

test('entries come back in the order they were queued', () => {
  withDir((dir) => {
    enqueue(dir, request({ goal: 'first' }), 1_000);
    enqueue(dir, request({ goal: 'second' }), 2_000);
    assert.equal(dequeue(dir, 3_000).entry.goal, 'first');
    assert.equal(dequeue(dir, 3_000).entry.goal, 'second');
    assert.equal(dequeue(dir, 3_000).entry, null);
  });
});

test('a goal that aged out is reported as skipped rather than run late', () => {
  withDir((dir) => {
    const at2am = Date.parse('2026-08-21T02:00:00Z');
    enqueue(dir, request({ goal: 'stale overnight goal' }), at2am);

    const at9am = Date.parse('2026-08-21T09:00:00Z');
    const result = dequeue(dir, at9am);
    assert.equal(result.entry, null, 'a seven-hour-old goal must not run blindly');
    assert.equal(result.expired.length, 1);
    assert.equal(result.expired[0].goal, 'stale overnight goal');
  });
});

test('an entry still inside its window runs normally', () => {
  withDir((dir) => {
    const at2am = Date.parse('2026-08-21T02:00:00Z');
    enqueue(dir, request(), at2am);
    assert.ok(dequeue(dir, at2am + DEFAULT_MAX_AGE_MS - 1000).entry);
  });
});

test('a per-entry maximum age overrides the default', () => {
  withDir((dir) => {
    enqueue(dir, request({ maxAgeMs: 60_000 }), 0);
    assert.equal(dequeue(dir, 120_000).entry, null);

    enqueue(dir, request({ maxAgeMs: 24 * 60 * 60 * 1000 }), 0);
    assert.ok(dequeue(dir, DEFAULT_MAX_AGE_MS + 1000).entry, 'a longer window is honoured');
  });
});

test('an hourly trigger firing during a long mission does not stack copies', () => {
  withDir((dir) => {
    for (let hour = 0; hour < 8; hour++) {
      enqueue(dir, request({ triggerId: 'nightly', goal: `run at hour ${hour}` }), hour * 3_600_000);
    }
    const waiting = peek(dir, 8 * 3_600_000);
    assert.equal(waiting.length, 1, 'one trigger, one pending entry');
    assert.equal(waiting[0].goal, 'run at hour 7', 'the newest request wins');
  });
});

test('different triggers queue independently', () => {
  withDir((dir) => {
    enqueue(dir, request({ triggerId: 'tests' }));
    enqueue(dir, request({ triggerId: 'docs' }));
    assert.equal(peek(dir).length, 2);
  });
});

test('entries without a trigger id are never de-duplicated against each other', () => {
  withDir((dir) => {
    enqueue(dir, request({ goal: 'one-off a' }));
    enqueue(dir, request({ goal: 'one-off b' }));
    assert.equal(peek(dir).length, 2);
  });
});

test('cancelling one conversation keeps unrelated queued work', () => {
  withDir((dir) => {
    enqueue(dir, request({ goal: 'discord one', chatId: 'discord-1' }));
    enqueue(dir, request({ goal: 'discord two', chatId: 'discord-2' }));
    enqueue(dir, request({ goal: 'scheduled', triggerId: 'nightly', chatId: 'trigger-nightly' }));
    const result = cancel(dir, (entry) => entry.chatId === 'discord-1');
    assert.deepEqual(result.removed.map((entry) => entry.goal), ['discord one']);
    assert.deepEqual(peek(dir).map((entry) => entry.goal), ['discord two', 'scheduled']);
  });
});

test('the enqueue time is recorded so the caller can re-check the tree at dequeue', () => {
  withDir((dir) => {
    enqueue(dir, request(), Date.parse('2026-08-21T02:00:00Z'));
    const entry = dequeue(dir, Date.parse('2026-08-21T03:00:00Z')).entry;
    assert.equal(entry.enqueuedAt, '2026-08-21T02:00:00.000Z');
    assert.equal(entry.cwd, '/project', 'the directory is carried, not a snapshot of it');
  });
});

test('a request missing a goal or directory is refused', () => {
  withDir((dir) => {
    assert.equal(enqueue(dir, { cwd: '/project' }).ok, false);
    assert.equal(enqueue(dir, { goal: '   ', cwd: '/project' }).ok, false);
    assert.equal(enqueue(dir, { goal: 'x' }).ok, false);
    assert.deepEqual(peek(dir), []);
  });
});

test('the queue cannot grow without bound', () => {
  withDir((dir) => {
    for (let i = 0; i < MAX_ENTRIES + 20; i++) enqueue(dir, request({ goal: `goal ${i}` }));
    assert.equal(peek(dir).length, MAX_ENTRIES);
    assert.equal(dequeue(dir).entry.goal, 'goal 20', 'the oldest are dropped, the newest kept');
  });
});

test('a missing or corrupt queue file reads as empty rather than throwing', () => {
  withDir((dir) => {
    assert.deepEqual(peek(dir), []);
    assert.equal(dequeue(dir).entry, null);

    fs.mkdirSync(path.dirname(queuePath(dir)), { recursive: true });
    fs.writeFileSync(queuePath(dir), 'not json at all', 'utf8');
    assert.deepEqual(peek(dir), []);
    assert.doesNotThrow(() => enqueue(dir, request()));
    assert.equal(peek(dir).length, 1, 'a corrupt file is replaced, not appended to');
  });
});

test('the queue survives being written and read again', () => {
  withDir((dir) => {
    enqueue(dir, request({ goal: 'persisted', triggerId: 'nightly' }));
    assert.ok(fs.existsSync(queuePath(dir)));
    assert.equal(peek(dir)[0].goal, 'persisted');
    clear(dir);
    assert.deepEqual(peek(dir), []);
  });
});
