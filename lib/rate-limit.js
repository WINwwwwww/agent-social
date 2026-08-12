// 极简内存限流器：单进程够用，不引入额外依赖。
// 如果之后部署成多实例，需要换成共享存储（Redis 等）。
function rateLimit({ windowMs, max, key, onLimit }) {
  const hits = new Map();

  function sweep(now) {
    for (const [k, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(k);
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    if (hits.size > 5000) sweep(now);

    const id = key(req);
    let entry = hits.get(id);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(id, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return onLimit(req, res, retryAfter);
    }
    return next();
  };
}

module.exports = { rateLimit };
