import { HttpError } from '../errors.js';

/**
 * Sliding-window limiter kept in process memory. Good for a single
 * instance; move to a shared store if the service is scaled out.
 *
 * @param {object} options
 * @param {number} options.perMinute   allowed requests per key per minute
 * @param {Function} [options.keyFor]  (req) => string; defaults to user id, then IP
 * @param {Function} [options.now]     clock, injectable for tests
 */
export function rateLimit({ perMinute, keyFor = (req) => req.user?.id ?? req.ip, now = Date.now }) {
  const windowMs = 60_000;
  const hits = new Map();

  const sweep = () => {
    const cutoff = now() - windowMs;
    for (const [key, times] of hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  };
  const sweeper = setInterval(sweep, windowMs);
  sweeper.unref?.();

  const middleware = (req, res, next) => {
    const key = String(keyFor(req));
    const cutoff = now() - windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= perMinute) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - now()) / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return next(new HttpError(429, `Rate limit of ${perMinute} requests per minute exceeded`, { retryAfterSeconds: retryAfterSec }));
    }
    recent.push(now());
    hits.set(key, recent);
    res.set('X-RateLimit-Limit', String(perMinute));
    res.set('X-RateLimit-Remaining', String(perMinute - recent.length));
    next();
  };
  middleware.stop = () => clearInterval(sweeper);
  return middleware;
}
