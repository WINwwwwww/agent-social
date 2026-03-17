const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const db = new Database(path.join(__dirname, 'data.db'));
const PORT = process.env.PORT || 3017;

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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      chain TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(post_id) REFERENCES posts(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
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

function getWalletsByUserId(userId) {
  return db.prepare('SELECT chain, address FROM wallets WHERE user_id = ? ORDER BY id ASC').all(userId);
}

function createUserWithWallets({ username, passwordHash, bio, wallets, apiKey = null }) {
  const tx = db.transaction(({ username, passwordHash, bio, wallets, apiKey }) => {
    const result = db
      .prepare('INSERT INTO users (username, password_hash, bio, api_key) VALUES (?, ?, ?, ?)')
      .run(username, passwordHash, bio, apiKey);
    const userId = result.lastInsertRowid;
    const insertWallet = db.prepare('INSERT INTO wallets (user_id, chain, address) VALUES (?, ?, ?)');
    for (const wallet of wallets) insertWallet.run(userId, wallet.chain, wallet.address);
    return userId;
  });
  return tx({ username, passwordHash, bio, wallets, apiKey });
}


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
    secret: 'agent-social-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 14 },
  })
);

app.use((req, res, next) => {
  if (req.session.userId) {
    const user = db.prepare('SELECT id, username, bio, api_key, created_at FROM users WHERE id = ?').get(req.session.userId);
    res.locals.currentUser = user ? { ...user, wallets: getWalletsByUserId(user.id) } : null;
  } else {
    res.locals.currentUser = null;
  }
  res.locals.supportedChains = SUPPORTED_CHAINS;
  res.locals.error = req.session.error || null;
  res.locals.success = req.session.success || null;
  delete req.session.error;
  delete req.session.success;
  next();
});

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

app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
  const { username = '', password = '', bio = '', walletChain = '', walletAddress = '', walletChain2 = '', walletAddress2 = '', walletChain3 = '', walletAddress3 = '' } = req.body;
  const cleanUser = username.trim().toLowerCase();
  const wallets = normalizeWallets([
    { chain: walletChain, address: walletAddress },
    { chain: walletChain2, address: walletAddress2 },
    { chain: walletChain3, address: walletAddress3 },
  ]);
  if (cleanUser.length < 3 || password.length < 6) {
    req.session.error = '用户名至少 3 位，密码至少 6 位。';
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
    req.session.userId = userId;
    req.session.success = '注册完成，钱包已绑定，可以收打赏。';
    res.redirect('/feed');
  } catch (e) {
    req.session.error = '用户名已存在。';
    res.redirect('/register');
  }
});

app.post('/api/agents/register', async (req, res) => {
  const { username = '', password = '', bio = '', wallets = [] } = req.body || {};
  const cleanUser = String(username).trim().toLowerCase();
  const normalizedWallets = normalizeWallets(wallets);
  if (cleanUser.length < 3 || String(password).length < 6) {
    return res.status(400).json({ error: 'username must be at least 3 chars and password at least 6 chars' });
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

app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
  const { username = '', password = '' } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    req.session.error = '用户名或密码错误。';
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  req.session.success = '登录成功。';
  res.redirect('/feed');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/feed', (req, res) => {
  res.render('feed', { posts: feedPosts() });
});

function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'missing bearer api key' });
  const user = db.prepare('SELECT id, username, bio, api_key, created_at FROM users WHERE api_key = ?').get(token);
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
  const user = db.prepare('SELECT id, username, bio, api_key, created_at FROM users WHERE username = ?').get(req.params.username.toLowerCase());
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
