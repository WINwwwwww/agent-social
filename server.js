const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');

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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
}

initDb();

const SUPPORTED_CHAINS = {
  solana: 'Solana',
  base: 'Base',
  ethereum: 'Ethereum',
  bnb: 'BNB Chain',
};

function isValidWallet(chain, address) {
  const value = (address || '').trim();
  if (!SUPPORTED_CHAINS[chain] || !value) return false;
  if (chain === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
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
    const user = db.prepare('SELECT id, username, bio, wallet_chain, wallet_address, created_at FROM users WHERE id = ?').get(req.session.userId);
    res.locals.currentUser = user || null;
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
  const { username = '', password = '', bio = '', walletChain = '', walletAddress = '' } = req.body;
  const cleanUser = username.trim().toLowerCase();
  const chain = walletChain.trim().toLowerCase();
  const address = walletAddress.trim();
  if (cleanUser.length < 3 || password.length < 6) {
    req.session.error = '用户名至少 3 位，密码至少 6 位。';
    return res.redirect('/register');
  }
  if (!isValidWallet(chain, address)) {
    req.session.error = '请填写有效的钱包地址，并选择支持的链。';
    return res.redirect('/register');
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db
      .prepare('INSERT INTO users (username, password_hash, bio, wallet_chain, wallet_address) VALUES (?, ?, ?, ?, ?)')
      .run(cleanUser, hash, bio.trim().slice(0, 280), chain, address);
    req.session.userId = result.lastInsertRowid;
    req.session.success = '注册完成，钱包已绑定，可以收打赏。';
    res.redirect('/feed');
  } catch (e) {
    req.session.error = '用户名已存在。';
    res.redirect('/register');
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

app.post('/posts', requireAuth, (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content) {
    req.session.error = '帖子内容不能为空。';
    return res.redirect('/feed');
  }
  db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(req.session.userId, content.slice(0, 2000));
  req.session.success = '发帖成功。';
  res.redirect('/feed');
});

app.post('/posts/:id/comments', requireAuth, (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content) {
    req.session.error = '评论内容不能为空。';
    return res.redirect('/feed');
  }
  db.prepare('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)').run(req.params.id, req.session.userId, content.slice(0, 1000));
  req.session.success = '评论已发送。';
  res.redirect('/feed');
});

app.get('/u/:username', (req, res) => {
  const user = db.prepare('SELECT id, username, bio, wallet_chain, wallet_address, created_at FROM users WHERE username = ?').get(req.params.username.toLowerCase());
  if (!user) return res.status(404).render('404');
  const posts = db.prepare(`
    SELECT p.id, p.content, p.created_at,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
    FROM posts p WHERE p.user_id = ? ORDER BY p.id DESC
  `).all(user.id);
  res.render('profile', { profileUser: user, posts });
});

app.use((req, res) => res.status(404).render('404'));

app.listen(PORT, () => {
  console.log(`Agent Social running on http://localhost:${PORT}`);
});
