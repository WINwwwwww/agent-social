const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const SqliteSessionStore = require('../lib/sqlite-session-store');

const promisify = (store, method, ...args) =>
  new Promise((resolve, reject) => {
    store[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });

// 每个用例用独立的内存库，并在结束时显式关闭。
// 让 better-sqlite3 的 Database 被 GC 回收（而不是主动 close）会在 Linux 上偶发 SIGSEGV。
async function withStore(fn) {
  const db = new Database(':memory:');
  const store = new SqliteSessionStore(db, { cleanupIntervalMs: 0 });
  try {
    await fn(store);
  } finally {
    store.close();
    db.close();
  }
}

const sessionWithMaxAge = (maxAge, extra = {}) => ({
  cookie: { originalMaxAge: maxAge, maxAge },
  ...extra,
});

test('set then get round-trips the session', () =>
  withStore(async (store) => {
    await promisify(store, 'set', 'sid-1', sessionWithMaxAge(60000, { userId: 7 }));
    const loaded = await promisify(store, 'get', 'sid-1');
    assert.strictEqual(loaded.userId, 7);
  }));

test('missing session resolves to null', () =>
  withStore(async (store) => {
    assert.strictEqual(await promisify(store, 'get', 'nope'), null);
  }));

test('expired session is not returned and prune removes it', () =>
  withStore(async (store) => {
    await promisify(store, 'set', 'sid-old', sessionWithMaxAge(-1000));
    assert.strictEqual(await promisify(store, 'get', 'sid-old'), null);
    assert.strictEqual(await promisify(store, 'length'), 0);
    store.prune();
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
  }));

test('set on an existing sid overwrites instead of failing', () =>
  withStore(async (store) => {
    await promisify(store, 'set', 'sid-2', sessionWithMaxAge(60000, { userId: 1 }));
    await promisify(store, 'set', 'sid-2', sessionWithMaxAge(60000, { userId: 2 }));
    const loaded = await promisify(store, 'get', 'sid-2');
    assert.strictEqual(loaded.userId, 2);
    assert.strictEqual(await promisify(store, 'length'), 1);
  }));

test('touch extends expiry without touching data', () =>
  withStore(async (store) => {
    await promisify(store, 'set', 'sid-3', sessionWithMaxAge(1000, { userId: 3 }));
    await promisify(store, 'touch', 'sid-3', sessionWithMaxAge(120000));
    const loaded = await promisify(store, 'get', 'sid-3');
    assert.strictEqual(loaded.userId, 3);
  }));

test('destroy and clear remove sessions', () =>
  withStore(async (store) => {
    await promisify(store, 'set', 'sid-4', sessionWithMaxAge(60000));
    await promisify(store, 'set', 'sid-5', sessionWithMaxAge(60000));
    await promisify(store, 'destroy', 'sid-4');
    assert.strictEqual(await promisify(store, 'get', 'sid-4'), null);
    assert.strictEqual(await promisify(store, 'length'), 1);

    await promisify(store, 'clear');
    assert.strictEqual(await promisify(store, 'length'), 0);
  }));

test('all returns only live sessions and skips corrupted rows', () =>
  withStore(async (store) => {
    await promisify(store, 'set', 'sid-live', sessionWithMaxAge(60000, { userId: 9 }));
    await promisify(store, 'set', 'sid-dead', sessionWithMaxAge(-1000));
    store.db
      .prepare('INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?)')
      .run('sid-broken', Date.now() + 60000, '{not json');

    const all = await promisify(store, 'all');
    assert.deepStrictEqual(Object.keys(all), ['sid-live']);
  }));

test('corrupted session data reads as missing rather than throwing', () =>
  withStore(async (store) => {
    store.db
      .prepare('INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?)')
      .run('sid-bad', Date.now() + 60000, '{oops');
    assert.strictEqual(await promisify(store, 'get', 'sid-bad'), null);
  }));
