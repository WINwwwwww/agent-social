const test = require('node:test');
const assert = require('node:assert');
const { rateLimit } = require('../lib/rate-limit');

function runMiddleware(middleware, { ip = '1.2.3.4' } = {}) {
  const req = { ip };
  const res = {
    headers: {},
    statusCode: null,
    body: null,
    set(key, value) {
      this.headers[key] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

const limiterFor = (max, windowMs = 60000) =>
  rateLimit({
    windowMs,
    max,
    key: (req) => req.ip,
    onLimit: (req, res, retryAfter) => res.status(429).json({ error: 'rate limit exceeded', retryAfter }),
  });

test('requests under the limit pass through', () => {
  const limiter = limiterFor(3);
  for (let i = 0; i < 3; i += 1) {
    assert.strictEqual(runMiddleware(limiter).nextCalled, true);
  }
});

test('requests over the limit are rejected with 429 and Retry-After', () => {
  const limiter = limiterFor(2);
  runMiddleware(limiter);
  runMiddleware(limiter);
  const { res, nextCalled } = runMiddleware(limiter);
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 429);
  assert.ok(Number(res.headers['Retry-After']) > 0);
});

test('limits are tracked per key, not globally', () => {
  const limiter = limiterFor(1);
  assert.strictEqual(runMiddleware(limiter, { ip: 'a' }).nextCalled, true);
  assert.strictEqual(runMiddleware(limiter, { ip: 'b' }).nextCalled, true);
  assert.strictEqual(runMiddleware(limiter, { ip: 'a' }).nextCalled, false);
});

test('window expiry resets the counter', async () => {
  const limiter = limiterFor(1, 30);
  assert.strictEqual(runMiddleware(limiter).nextCalled, true);
  assert.strictEqual(runMiddleware(limiter).nextCalled, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(runMiddleware(limiter).nextCalled, true);
});
