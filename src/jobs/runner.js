import { HttpError } from '../errors.js';
import { getForum } from '../forums/index.js';
import { isoDay } from '../validation.js';
import { searchThreads } from '../services/perplexity.js';
import { leadsEmail } from './email.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const parseDay = (value) => new Date(`${value}T00:00:00Z`);

/**
 * The next time the daily slot comes round: today at `hour` UTC if that is still ahead, otherwise
 * tomorrow. Every run books the next one this way, so a job settles into the same slot each day
 * however late a given run happened to start.
 */
export const nextRunAtHour = (hour, now) => {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

/** Milliseconds until the next daily slot, for scheduling the timer. */
export const msUntilHour = (hour, now) => nextRunAtHour(hour, now).getTime() - now.getTime();


/**
 * The days a run searches: the trailing `lookbackDays`, not just yesterday and today. Perplexity's
 * index trails the forums by about two days, so a two-day window searches exactly the posts it has
 * not indexed yet and comes back empty. A week-wide window catches a post once it becomes
 * searchable, and costs the same, since it is still one call per forum. The overlap between runs is
 * harmless: stored threads are keyed on their link, and only leads not already stored are emailed.
 *
 * After a longer gap than that (the server was down, or searches kept failing) it starts from the
 * last day a successful run covered instead, so no day is skipped. Capped at the search's maximum
 * range.
 */
export const searchWindow = (job, { now, maxDays, lookbackDays }) => {
  const today = utcDay(now);
  let from = new Date(today.getTime() - lookbackDays * DAY_MS);
  if (job.lastDateTo) {
    const lastCovered = parseDay(job.lastDateTo);
    if (lastCovered < from) from = lastCovered;
  }
  const earliest = new Date(today.getTime() - maxDays * DAY_MS);
  if (from < earliest) from = earliest;
  return { from, to: today };
};

/**
 * Runs due search jobs. Each run searches the job's forums for the last day, stores the
 * threads scoring at least the job's min_score under the product, emails the user the ones
 * not stored before, and records the run.
 *
 * Everything is written with the service-role key, since the user is not signed in when
 * their job runs. Without that key the runner does nothing and says so once.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.db          Supabase REST client
 * @param {object} deps.jobs        jobs service (src/services/jobs.js)
 * @param {object} deps.results     results service; leads are stored like any other search
 * @param {object} deps.searchLog   search log; job searches are logged like interactive ones
 * @param {object} deps.mailer      mailer (src/services/mailer.js)
 * @param {Function} [deps.search]  thread search, injectable for tests
 * @param {object} [deps.logger]
 * @param {Function} [deps.now]     clock, injectable for tests
 */
export function createJobRunner({ config, db, jobs, results, searchLog, mailer, search = searchThreads, logger = console, now = () => new Date() }) {
  const serviceToken = config.supabase.serviceRoleKey;
  let warned = false;
  let running = false;
  let started = false;
  const timers = [];

  const keep = (t) => {
    t.unref?.();
    timers.push(t);
    return t;
  };

  const runJob = async (job, ranAt) => {
    const { from, to } = searchWindow(job, { now: ranAt, maxDays: config.limits.maxDays, lookbackDays: config.jobs.lookbackDays });
    const base = { jobId: job.id, userId: job.userId, productId: job.productId, ranAt, from: isoDay(from), to: isoDay(to) };
    let outcome;
    try {
      const product = await db.selectOne(serviceToken, 'products', { select: '*', id: `eq.${job.productId}` });
      const forums = job.forums.map((id) => getForum(id)).filter(Boolean);
      if (forums.length === 0) throw new HttpError(400, 'Job has no supported forums', { forums: job.forums });

      const logEntry = { productId: job.productId, userId: job.userId, forums: forums.map((f) => f.id), threadsRequested: job.threads, from: base.from, to: base.to };
      let found;
      try {
        found = await search({ productDescription: product.description, forums, threads: job.threads, from, to, config });
      } catch (err) {
        await searchLog.record(serviceToken, { ...logEntry, status: 'error', error: err?.message, errorStatus: err?.status, diagnostics: err?.diagnostics });
        throw err;
      }
      await searchLog.record(serviceToken, { ...logEntry, status: 'ok', returnedCount: found.threads.length, diagnostics: found.diagnostics });

      const leads = found.threads.filter((t) => Number(t.relevanceScore) >= job.minScore);
      const stored = await results.save(serviceToken, job.productId, leads, { searchDate: ranAt });
      const newLinks = new Set(stored.filter((r) => r.isNew).map((r) => r.link));
      const newLeads = leads.filter((t) => newLinks.has(t.url));

      let emailStatus = 'skipped';
      let emailError = null;
      if (newLeads.length > 0) {
        if (!mailer.configured) {
          emailStatus = 'not_configured';
        } else {
          try {
            await mailer.send({ to: job.email, ...leadsEmail({ product, job, leads: newLeads, from, to }) });
            emailStatus = 'sent';
          } catch (err) {
            emailStatus = 'failed';
            emailError = err?.message ?? String(err);
            logger.error(`job ${job.id}: email failed:`, emailError);
          }
        }
      }
      outcome = { ...base, status: 'ok', foundCount: found.threads.length, leadCount: leads.length, newLeadCount: newLeads.length, emailStatus, emailError, durationMs: now() - ranAt };
    } catch (err) {
      logger.error(`job ${job.id}: run failed:`, err?.message ?? err);
      outcome = { ...base, status: 'error', error: err?.message ?? String(err), errorStatus: Number.isInteger(err?.status) ? err.status : null, durationMs: now() - ranAt };
    }

    // The claim already moved next_run_at forward; the job is done when that lands past its end date.
    const completed = isoDay(new Date(job.nextRunAt)) > job.endDate;
    try {
      await jobs.finish(serviceToken, job.id, {
        status: completed ? 'completed' : undefined,
        lastStatus: outcome.status,
        lastError: outcome.error ?? null,
        lastDateTo: outcome.status === 'ok' ? outcome.to : undefined,
        runCount: job.runCount + 1,
      });
      await jobs.recordRun(serviceToken, outcome);
    } catch (err) {
      logger.error(`job ${job.id}: could not record the run:`, err?.message ?? err);
    }
    return { ...outcome, completed };
  };

  /**
   * Runs every due job, one after another, in batches until none are left. Resolves to the
   * outcomes; never throws. Running daily means a single batch would strand every job past the
   * batch size until the following day, so this keeps going rather than stopping at one page.
   */
  const runDueJobs = async () => {
    if (!serviceToken) {
      if (!warned) logger.warn('SUPABASE_SERVICE_ROLE_KEY is not set; scheduled search jobs will not run.');
      warned = true;
      return [];
    }
    if (running) return [];
    running = true;
    try {
      const outcomes = [];
      // Each claim moves next_run_at a day ahead, so a job leaves the due set once it has run and
      // the next fetch returns only what is still outstanding. The cap is a guard against a job
      // that somehow stays due, which would otherwise loop forever.
      for (let batch = 0; batch < 100; batch += 1) {
        const due = await jobs.due(serviceToken, { now: now(), limit: config.jobs.batchSize });
        if (due.length === 0) break;
        let claimedAny = false;
        for (const job of due) {
          const ranAt = now();
          const claimed = await jobs.claim(serviceToken, job, { nextRunAt: nextRunAtHour(config.jobs.runAtHour, ranAt), lastRunAt: ranAt });
          if (!claimed) continue; // another runner took it
          claimedAny = true;
          outcomes.push(await runJob(claimed, ranAt));
        }
        if (!claimedAny) break; // every job in the page belongs to another runner
      }
      return outcomes;
    } catch (err) {
      logger.error('job runner: run failed:', err?.message ?? err);
      return [];
    } finally {
      running = false;
    }
  };

  return {
    runDueJobs,
    runJob,

    /**
     * Starts the runner. Jobs run once a day, in the config.jobs.runAtHour slot, and the timer is
     * rescheduled from the clock after each run rather than repeating on a fixed interval, so it
     * cannot drift off the hour. One extra pass shortly after boot catches jobs left overdue
     * because the server was down or restarting when their slot came round.
     */
    start({ firstDelayMs = 10_000 } = {}) {
      if (!config.jobs.enabled || started) return false;
      started = true;
      keep(setTimeout(runDueJobs, firstDelayMs));
      const scheduleNext = () => {
        keep(
          setTimeout(async () => {
            await runDueJobs();
            scheduleNext();
          }, msUntilHour(config.jobs.runAtHour, now())),
        );
      };
      scheduleNext();
      return true;
    },

    stop() {
      for (const t of timers.splice(0)) {
        clearTimeout(t);
        clearInterval(t);
      }
      started = false;
    },
  };
}
