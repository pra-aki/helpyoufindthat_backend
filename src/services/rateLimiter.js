import { PerplexityError } from '../errors.js';

/**
 * Spaces outgoing calls so they cannot outrun a shared rate limit.
 *
 * Perplexity's limit applies to the whole account rather than to one user, and it
 * works as a leaky bucket: at 50 requests a minute, roughly one request becomes
 * available every 1.2 seconds. Six forum calls sent at once got five HTTP 429s,
 * so every call now takes its turn here.
 *
 * The queue lives in one process. Running more than one instance of the server
 * would need a shared queue, since the limit is per account.
 */
export function createRateLimiter({
  minIntervalMs = 1200,
  maxWaitMs = 30_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let nextStart = 0;
  let waiting = 0;

  return {
    /** Runs `task` when its turn comes, passing it how long it waited. */
    async schedule(task) {
      const at = now();
      const startAt = Math.max(at, nextStart);
      const waitedMs = startAt - at;

      if (waitedMs > maxWaitMs) {
        throw new PerplexityError(
          `Too many searches are queued; the next free slot is about ${Math.round(waitedMs / 1000)}s away`,
          { status: 429, details: { waitedMs, maxWaitMs } },
        );
      }

      // Claim the slot before awaiting, so calls scheduled in the same tick queue behind each other.
      nextStart = startAt + minIntervalMs;

      if (waitedMs > 0) {
        waiting += 1;
        try {
          await sleep(waitedMs);
        } finally {
          waiting -= 1;
        }
      }
      return task({ waitedMs });
    },

    /** Current queue depth and how long a new call would wait. */
    stats: () => ({ waiting, nextSlotInMs: Math.max(0, nextStart - now()) }),
  };
}
