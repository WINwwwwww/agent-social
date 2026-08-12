const session = require('express-session');

const Store = session.Store;

// 基于 better-sqlite3 的 express-session store。
// 项目本来就依赖 better-sqlite3，用它替掉 connect-sqlite3 可以少一个原生 SQLite 驱动。
class SqliteSessionStore extends Store {
  constructor(db, { table = 'sessions', cleanupIntervalMs = 1000 * 60 * 15 } = {}) {
    super();
    this.db = db;
    this.table = table;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        sid TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${table}_expires ON ${table}(expires_at);
    `);

    this.stmts = {
      get: db.prepare(`SELECT data FROM ${table} WHERE sid = ? AND expires_at > ?`),
      set: db.prepare(`
        INSERT INTO ${table} (sid, expires_at, data) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data
      `),
      touch: db.prepare(`UPDATE ${table} SET expires_at = ? WHERE sid = ?`),
      destroy: db.prepare(`DELETE FROM ${table} WHERE sid = ?`),
      clear: db.prepare(`DELETE FROM ${table}`),
      length: db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE expires_at > ?`),
      all: db.prepare(`SELECT sid, data FROM ${table} WHERE expires_at > ?`),
      prune: db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`),
    };

    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.prune(), cleanupIntervalMs);
      this.cleanupTimer.unref();
    }
  }

  expiresAt(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    if (cookieExpires) return new Date(cookieExpires).getTime();
    const maxAge = sess && sess.cookie && sess.cookie.originalMaxAge;
    return Date.now() + (maxAge || 1000 * 60 * 60 * 24);
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid, Date.now());
      if (!row) return cb(null, null);
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      // 数据损坏的会话按“不存在”处理，避免整个请求 500。
      return cb(null, null);
    }
  }

  set(sid, sess, cb) {
    try {
      this.stmts.set.run(sid, this.expiresAt(sess), JSON.stringify(sess));
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.stmts.touch.run(this.expiresAt(sess), sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.stmts.destroy.run(sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  clear(cb) {
    try {
      this.stmts.clear.run();
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  length(cb) {
    try {
      return cb(null, this.stmts.length.get(Date.now()).c);
    } catch (err) {
      return cb(err);
    }
  }

  all(cb) {
    try {
      const sessions = {};
      for (const row of this.stmts.all.all(Date.now())) {
        try {
          sessions[row.sid] = JSON.parse(row.data);
        } catch (_) {
          // 跳过损坏行
        }
      }
      return cb(null, sessions);
    } catch (err) {
      return cb(err);
    }
  }

  prune() {
    try {
      this.stmts.prune.run(Date.now());
    } catch (_) {
      // 后台清理失败不影响请求处理
    }
  }

  close() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

module.exports = SqliteSessionStore;
