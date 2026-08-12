const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-social-')), 'test.db');
process.env.DATABASE_PATH = tmpDb;
process.env.NODE_ENV = 'test';

const { app } = require('../server');

let baseUrl;
let server;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
});

const wallet = (address) => [{ chain: 'ethereum', address }];
const ADDR_A = '0x1111111111111111111111111111111111111111';
const ADDR_B = '0x2222222222222222222222222222222222222222';

async function registerAgent(username, address) {
  const res = await fetch(`${baseUrl}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123', bio: 'test agent', wallets: wallet(address) }),
  });
  return { status: res.status, body: await res.json() };
}

test('landing page renders', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /AgentSocial/);
});

test('unknown route returns 404', async () => {
  const res = await fetch(`${baseUrl}/definitely-not-a-page`);
  assert.strictEqual(res.status, 404);
});

test('agent registration returns an api key', async () => {
  const { status, body } = await registerAgent('alpha_agent', ADDR_A);
  assert.strictEqual(status, 201);
  assert.strictEqual(body.ok, true);
  assert.match(body.apiKey, /^agsk_[0-9a-f]{48}$/);
  assert.strictEqual(body.agent.username, 'alpha_agent');
  assert.strictEqual(body.agent.wallets.length, 1);
});

test('registration rejects bad username, short password and invalid wallet', async () => {
  const bad = await fetch(`${baseUrl}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'A B', password: 'secret123', wallets: wallet(ADDR_B) }),
  });
  assert.strictEqual(bad.status, 400);

  const shortPw = await fetch(`${baseUrl}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'short_pw', password: '123', wallets: wallet(ADDR_B) }),
  });
  assert.strictEqual(shortPw.status, 400);

  const badWallet = await fetch(`${baseUrl}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'bad_wallet', password: 'secret123', wallets: wallet('0xnope') }),
  });
  assert.strictEqual(badWallet.status, 400);
});

test('duplicate username is rejected with 409', async () => {
  const { status } = await registerAgent('alpha_agent', ADDR_B);
  assert.strictEqual(status, 409);
});

test('api key is required for posting, and works once provided', async () => {
  const { body } = await registerAgent('poster_agent', ADDR_B);
  const apiKey = body.apiKey;

  const noAuth = await fetch(`${baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello' }),
  });
  assert.strictEqual(noAuth.status, 401);

  const badAuth = await fetch(`${baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer agsk_wrong' },
    body: JSON.stringify({ content: 'hello' }),
  });
  assert.strictEqual(badAuth.status, 401);

  const created = await fetch(`${baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ content: 'hello from a test agent' }),
  });
  assert.strictEqual(created.status, 201);
  const post = (await created.json()).post;

  const empty = await fetch(`${baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ content: '   ' }),
  });
  assert.strictEqual(empty.status, 400);

  const comment = await fetch(`${baseUrl}/api/posts/${post.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ content: 'nice post' }),
  });
  assert.strictEqual(comment.status, 201);

  const missingPost = await fetch(`${baseUrl}/api/posts/999999/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ content: 'nope' }),
  });
  assert.strictEqual(missingPost.status, 404);
});

test('feed shows posts with their comments attached', async () => {
  const res = await fetch(`${baseUrl}/feed`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /hello from a test agent/);
  assert.match(html, /nice post/);
});

test('profile page renders wallets, unknown profile 404s', async () => {
  const res = await fetch(`${baseUrl}/u/poster_agent`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), new RegExp(ADDR_B));

  const missing = await fetch(`${baseUrl}/u/nobody_here`);
  assert.strictEqual(missing.status, 404);
});

test('api key rotation invalidates the old key', async () => {
  const { body } = await registerAgent('rotate_agent', '0x3333333333333333333333333333333333333333');
  const oldKey = body.apiKey;

  const rotated = await fetch(`${baseUrl}/api/me/api-key/rotate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${oldKey}` },
  });
  assert.strictEqual(rotated.status, 200);
  const newKey = (await rotated.json()).apiKey;
  assert.notStrictEqual(newKey, oldKey);

  const withOld = await fetch(`${baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oldKey}` },
    body: JSON.stringify({ content: 'should fail' }),
  });
  assert.strictEqual(withOld.status, 401);

  const withNew = await fetch(`${baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${newKey}` },
    body: JSON.stringify({ content: 'should work' }),
  });
  assert.strictEqual(withNew.status, 201);
});

test('web form posts without a csrf token are rejected', async () => {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=alpha_agent&password=secret123',
    redirect: 'manual',
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/');
});

test('plaintext api keys are never stored in the users table', async () => {
  const { db } = require('../server');
  const leaked = db.prepare('SELECT COUNT(*) AS c FROM users WHERE api_key IS NOT NULL').get().c;
  assert.strictEqual(leaked, 0);
});
