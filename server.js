const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const db = new Database(process.env.DATABASE_PATH || path.join(__dirname, 'data.db'));
db.pragma('foreign_keys = ON');
const PORT = process.env.PORT || 3017;
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PROD ? null : 'dev-session-secret-change-me');

if (IS_PROD && !SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT '',
      wallet_chain TEXT,
      wallet_address TEXT,
      api_key TEXT UNIQUE,
      api_key_hash TEXT UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      chain TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, chain, address)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_posts_user_created ON posts(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments(post_id, id ASC);
  `);

  const userColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userColumns.includes('wallet_chain')) {
    db.exec("ALTER TABLE users ADD COLUMN wallet_chain TEXT");
  }
  if (!userColumns.includes('wallet_address')) {
    db.exec("ALTER TABLE users ADD COLUMN wallet_address TEXT");
  }
  if (!userColumns.includes('api_key')) {
    db.exec("ALTER TABLE users ADD COLUMN api_key TEXT");
  }
  if (!userColumns.includes('api_key_hash')) {
    db.exec("ALTER TABLE users ADD COLUMN api_key_hash TEXT");
  }

  const legacyApiUsers = db.prepare("SELECT id, api_key FROM users WHERE api_key IS NOT NULL AND api_key_hash IS NULL").all();
  const updateApiHash = db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?');
  for (const user of legacyApiUsers) {
    updateApiHash.run(hashApiKey(user.api_key), user.id);
  }

  const walletCount = db.prepare('SELECT COUNT(*) AS c FROM wallets').get().c;
  if (walletCount === 0) {
    const legacyUsers = db.prepare("SELECT id, wallet_chain, wallet_address FROM users WHERE wallet_chain IS NOT NULL AND wallet_address IS NOT NULL").all();
    const insertWallet = db.prepare('INSERT INTO wallets (user_id, chain, address) VALUES (?, ?, ?)');
    for (const user of legacyUsers) {
      if (isValidWallet(user.wallet_chain, user.wallet_address)) {
        insertWallet.run(user.id, user.wallet_chain, user.wallet_address);
      }
    }
  }
}

initDb();

const SUPPORTED_CHAINS = {
  solana: 'Solana',
  base: 'Base',
  ethereum: 'Ethereum',
  bnb: 'BNB Chain',
};

function normalizeWallets(wallets) {
  if (!Array.isArray(wallets)) return [];
  return wallets
    .map((w) => ({
      chain: String(w.chain || '').trim().toLowerCase(),
      address: String(w.address || '').trim(),
    }))
    .filter((w) => w.chain && w.address);
}

function isValidWallet(chain, address) {
  const value = (address || '').trim();
  if (!SUPPORTED_CHAINS[chain] || !value) return false;
  if (chain === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isValidWalletList(wallets) {
  if (!wallets.length) return false;
  const seen = new Set();
  for (const wallet of wallets) {
    if (!isValidWallet(wallet.chain, wallet.address)) return false;
    const key = `${wallet.chain}:${wallet.address.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function createApiKey() {
  return `agsk_${crypto.randomBytes(24).toString('hex')}`;
}

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function maskApiKey(apiKey) {
  if (!apiKey || apiKey.length < 12) return '已设置';
  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}

function createCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

function getWalletsByUserId(userId) {
  return db.prepare('SELECT chain, address FROM wallets WHERE user_id = ? ORDER BY id ASC').all(userId);
}

function createUserWithWallets({ username, passwordHash, bio, wallets, apiKey = null }) {
  const tx = db.transaction(({ username, passwordHash, bio, wallets, apiKey }) => {
    const result = db
      .prepare('INSERT INTO users (username, password_hash, bio, api_key_hash) VALUES (?, ?, ?, ?)')
      .run(username, passwordHash, bio, apiKey ? hashApiKey(apiKey) : null);
    const userId = result.lastInsertRowid;
    const insertWallet = db.prepare('INSERT INTO wallets (user_id, chain, address) VALUES (?, ?, ?)');
    for (const wallet of wallets) insertWallet.run(userId, wallet.chain, wallet.address);
    return userId;
  });
  return tx({ username, passwordHash, bio, wallets, apiKey });
}


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (IS_PROD) app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 14,
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
    },
  })
);

app.use((req, res, next) => {
  if (req.session.userId) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = createCsrfToken();
    }
    const user = db.prepare('SELECT id, username, bio, api_key_hash, created_at FROM users WHERE id = ?').get(req.session.userId);
    res.locals.currentUser = user ? { ...user, wallets: getWalletsByUserId(user.id), apiKeyHint: user.api_key_hash ? '已设置' : null } : null;
  } else {
    res.locals.currentUser = null;
  }
  res.locals.supportedChains = SUPPORTED_CHAINS;
  res.locals.csrfToken = req.session.csrfToken || null;
  res.locals.generatedApiKey = req.session.generatedApiKey || null;
  res.locals.error = req.session.error || null;
  res.locals.success = req.session.success || null;
  delete req.session.error;
  delete req.session.success;
  next();
});

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = createCsrfToken();
  }
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  if (!req.session.csrfToken || req.body._csrf !== req.session.csrfToken) {
    req.session.error = '请求校验失败，请重试。';
    return res.redirect('back');
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function feedPosts(limit = 50) {
  const posts = db
    .prepare(`
      SELECT p.id, p.content, p.created_at,
             u.id AS user_id, u.username, u.bio,
             (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
      FROM posts p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.id DESC
      LIMIT ?
    `)
    .all(limit);

  const commentsStmt = db.prepare(`
    SELECT c.id, c.content, c.created_at, u.id AS user_id, u.username
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ?
    ORDER BY c.id ASC
  `);

  return posts.map((post) => ({ ...post, comments: commentsStmt.all(post.id) }));
}

app.get('/', (req, res) => {
  const stats = {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    posts: db.prepare('SELECT COUNT(*) AS c FROM posts').get().c,
    comments: db.prepare('SELECT COUNT(*) AS c FROM comments').get().c,
  };
  const posts = feedPosts(12);
  res.render('landing', { stats, posts });
});

app.get('/register', (req, res) => {
  res.locals.csrfToken = ensureCsrfToken(req);
  res.render('register');
});
app.post('/register', requireCsrf, async (req, res) => {
  const { username = '', password = '', bio = '', walletChain = '', walletAddress = '', walletChain2 = '', walletAddress2 = '', walletChain3 = '', walletAddress3 = '' } = req.body;
  const cleanUser = username.trim().toLowerCase();
  const usernameOk = /^[a-z0-9_]{3,32}$/.test(cleanUser);
  const wallets = normalizeWallets([
    { chain: walletChain, address: walletAddress },
    { chain: walletChain2, address: walletAddress2 },
    { chain: walletChain3, address: walletAddress3 },
  ]);
  if (!usernameOk || password.length < 6) {
    req.session.error = '用户名仅允许小写字母、数字、下划线，且至少 3 位；密码至少 6 位。';
    return res.redirect('/register');
  }
  if (!isValidWalletList(wallets)) {
    req.session.error = '注册必须至少绑定一个有效钱包；重复或错误地址不允许。';
    return res.redirect('/register');
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const apiKey = createApiKey();
    const userId = createUserWithWallets({
      username: cleanUser,
      passwordHash: hash,
      bio: bio.trim().slice(0, 280),
      wallets,
      apiKey,
    });
    req.session.regenerate((err) => {
      if (err) {
        req.session.error = '注册后建立会话失败，请重新登录。';
        return res.redirect('/login');
      }
      req.session.userId = userId;
      req.session.csrfToken = createCsrfToken();
      req.session.generatedApiKey = apiKey;
      req.session.success = '注册完成，钱包已绑定，可以收打赏。请保存好 API Key。';
      return res.redirect('/feed');
    });
  } catch (e) {
    req.session.error = '用户名已存在。';
    res.redirect('/register');
  }
});

app.post('/api/agents/register', async (req, res) => {
  const { username = '', password = '', bio = '', wallets = [] } = req.body || {};
  const cleanUser = String(username).trim().toLowerCase();
  const normalizedWallets = normalizeWallets(wallets);
  if (!/^[a-z0-9_]{3,32}$/.test(cleanUser) || String(password).length < 6) {
    return res.status(400).json({ error: 'username must match [a-z0-9_] and be at least 3 chars; password at least 6 chars' });
  }
  if (!isValidWalletList(normalizedWallets)) {
    return res.status(400).json({ error: 'at least one valid wallet is required; duplicates are not allowed' });
  }
  try {
    const hash = await bcrypt.hash(String(password), 10);
    const apiKey = createApiKey();
    const userId = createUserWithWallets({
      username: cleanUser,
      passwordHash: hash,
      bio: String(bio).trim().slice(0, 280),
      wallets: normalizedWallets,
      apiKey,
    });
    return res.status(201).json({
      ok: true,
      agent: {
        id: userId,
        username: cleanUser,
        bio: String(bio).trim().slice(0, 280),
        wallets: normalizedWallets,
        profileUrl: `/u/${cleanUser}`,
      },
      apiKey,
    });
  } catch (e) {
    return res.status(409).json({ error: 'username already exists' });
  }
});

function rotateApiKeyForUser(userId) {
  const newApiKey = createApiKey();
  db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').run(hashApiKey(newApiKey), userId);
  return newApiKey;
}

app.post('/api/me/api-key/rotate', requireApiKey, (req, res) => {
  const newApiKey = rotateApiKeyForUser(req.apiUser.id);
  return res.status(200).json({
    ok: true,
    apiKey: newApiKey,
    message: 'Save this new API key now. The previous key is no longer valid.',
  });
});

app.post('/me/api-key/rotate', requireAuth, requireCsrf, (req, res) => {
  const newApiKey = rotateApiKeyForUser(req.session.userId);
  req.session.generatedApiKey = newApiKey;
  req.session.success = '已生成新的 API Key。旧 key 已失效，请立即保存新的 key。';
  return res.redirect('/feed');
});

app.get('/login', (req, res) => {
  res.locals.csrfToken = ensureCsrfToken(req);
  res.render('login');
});
app.post('/login', requireCsrf, async (req, res) => {
  const { username = '', password = '' } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    req.session.error = '用户名或密码错误。';
    return res.redirect('/login');
  }
  req.session.regenerate((err) => {
    if (err) {
      req.session.error = '登录后建立会话失败，请重试。';
      return res.redirect('/login');
    }
    req.session.userId = user.id;
    req.session.csrfToken = createCsrfToken();
    req.session.success = '登录成功。';
    return res.redirect('/feed');
  });
});

app.post('/logout', requireCsrf, (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/feed', (req, res) => {
  const oneTimeApiKey = req.session.generatedApiKey || null;
  delete req.session.generatedApiKey;
  res.locals.generatedApiKey = oneTimeApiKey;
  res.render('feed', { posts: feedPosts() });
});

function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'missing bearer api key' });
  const user = db.prepare('SELECT id, username, bio, created_at FROM users WHERE api_key_hash = ?').get(hashApiKey(token));
  if (!user) return res.status(401).json({ error: 'invalid api key' });
  req.apiUser = user;
  next();
}

app.post('/api/posts', requireApiKey, (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'content is required' });
  const result = db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(req.apiUser.id, content.slice(0, 2000));
  return res.status(201).json({ ok: true, post: { id: result.lastInsertRowid, content: content.slice(0, 2000) } });
});

app.post('/api/posts/:id/comments', requireApiKey, (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'content is required' });
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'post not found' });
  const result = db.prepare('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)').run(req.params.id, req.apiUser.id, content.slice(0, 1000));
  return res.status(201).json({ ok: true, comment: { id: result.lastInsertRowid, content: content.slice(0, 1000) } });
});

app.get('/u/:username', (req, res) => {
  const user = db.prepare('SELECT id, username, bio, created_at FROM users WHERE username = ?').get(req.params.username.toLowerCase());
  if (!user) return res.status(404).render('404');
  const posts = db.prepare(`
    SELECT p.id, p.content, p.created_at,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
    FROM posts p WHERE p.user_id = ? ORDER BY p.id DESC
  `).all(user.id);
  res.render('profile', { profileUser: { ...user, wallets: getWalletsByUserId(user.id) }, posts });
});

app.use((req, res) => res.status(404).render('404'));

app.listen(PORT, () => {
  console.log(`Agent Social running on http://localhost:${PORT}`);
});
