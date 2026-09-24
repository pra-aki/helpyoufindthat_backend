import { HttpError } from '../errors.js';

/**
 * Scheduled searches ("jobs") and their run history.
 *
 * The user-facing methods take the caller's token, so row-level security scopes them to the
 * caller's own jobs. The runner methods take the service-role key, since the runner acts for
 * users who are not signed in when their job is due.
 */
const num = (value) => (value === null || value === undefined ? null : Number(value));

export const jobToApi = (row) =>
  row && {
    id: row.id,
    productId: row.product_id,
    userId: row.user_id,
    email: row.email,
    forums: row.forums,
    threads: row.threads,
    minScore: num(row.min_score),
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at ?? null,
    lastDateTo: row.last_date_to ?? null,
    lastStatus: row.last_status ?? null,
    lastError: row.last_error ?? null,
    runCount: row.run_count ?? 0,
    // One credit per forum each day the job runs.
    creditsPerRun: Array.isArray(row.forums) ? row.forums.length : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

export const runToApi = (row) =>
  row && {
    id: row.id,
    jobId: row.job_id,
    ranAt: row.ran_at,
    from: row.date_from,
    to: row.date_to,
    status: row.status,
    foundCount: row.found_count ?? null,
    leadCount: row.lead_count ?? null,
    newLeadCount: row.new_lead_count ?? null,
    emailStatus: row.email_status ?? null,
    emailError: row.email_error ?? null,
    creditsSpent: row.credits_spent ?? null,
    error: row.error ?? null,
    errorStatus: row.error_status ?? null,
    durationMs: row.duration_ms ?? null,
  };

export function createJobsService(db) {
  return {
    // ---------- as the signed-in user ----------

    /**
     * Schedules a job. Users cannot write search_jobs, so the route passes the service key here,
     * after checking the product is the caller's; user_id comes from the verified token. The route
     * books nextRunAt into the next daily slot.
     */
    async create(token, user, { productId, email, forums, threads, minScore, startDate, endDate, nextRunAt = new Date() }) {
      const row = await db.insert(token, 'search_jobs', {
        product_id: productId,
        user_id: user.id,
        email,
        forums: forums.map((f) => f.id),
        threads,
        min_score: minScore,
        start_date: startDate,
        end_date: endDate,
        status: 'active',
        next_run_at: nextRunAt.toISOString(),
      });
      return jobToApi(row);
    },

    async list(token, { productId, status } = {}) {
      const rows = await db.select(token, 'search_jobs', {
        select: '*',
        order: 'created_at.desc',
        product_id: productId ? `eq.${productId}` : undefined,
        status: status ? `eq.${status}` : undefined,
      });
      return (rows ?? []).map(jobToApi);
    },

    async get(token, id) {
      return jobToApi(await db.selectOne(token, 'search_jobs', { select: '*', id: `eq.${id}` }));
    },

    /** Number of the caller's active jobs, for the per-user cap. */
    async countActive(token) {
      const { total } = await db.selectPage(token, 'search_jobs', { select: 'id', status: 'eq.active', limit: '1' });
      return total;
    },

    /**
     * Stops a job. An already finished or cancelled job is returned unchanged. Reading it with the
     * caller's token proves it is theirs, since row-level security hides other users' jobs and
     * get() then 404s. Users cannot write search_jobs, so the update uses the service key, and is
     * filtered on the owner as well.
     */
    async cancel(token, id, { serviceToken, userId }) {
      const job = await this.get(token, id);
      if (job.status !== 'active') return job;
      return jobToApi(await db.update(serviceToken, 'search_jobs', { id: `eq.${id}`, user_id: `eq.${userId}` }, { status: 'cancelled' }));
    },

    async listRuns(token, jobId, { limit, offset }) {
      const { rows, total } = await db.selectPage(token, 'search_job_runs', {
        select: '*',
        job_id: `eq.${jobId}`,
        order: 'ran_at.desc',
        limit: String(limit),
        offset: String(offset),
      });
      return { runs: rows.map(runToApi), total };
    },

    // ---------- as the runner (service role) ----------

    /** Active jobs whose next run is due, oldest due first. */
    async due(serviceToken, { now = new Date(), limit = 20 } = {}) {
      const rows = await db.select(serviceToken, 'search_jobs', {
        select: '*',
        status: 'eq.active',
        next_run_at: `lte.${now.toISOString()}`,
        order: 'next_run_at.asc',
        limit: String(limit),
      });
      return (rows ?? []).map(jobToApi);
    },

    /**
     * Takes a due job for this run by moving next_run_at forward. The update is conditional on
     * next_run_at still being what we read, so two runners racing for the same job get it once.
     * Returns the claimed job, or null when another runner got there first.
     */
    async claim(serviceToken, job, { nextRunAt, lastRunAt }) {
      try {
        const row = await db.update(
          serviceToken,
          'search_jobs',
          { id: `eq.${job.id}`, status: 'eq.active', next_run_at: `eq.${job.nextRunAt}` },
          { next_run_at: nextRunAt.toISOString(), last_run_at: lastRunAt.toISOString() },
        );
        return jobToApi(row);
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },

    /** Records the outcome of a run on the job itself. */
    async finish(serviceToken, id, { status, lastStatus, lastError, lastDateTo, runCount }) {
      const patch = {
        last_status: lastStatus,
        last_error: lastError ?? null,
        run_count: runCount,
        ...(lastDateTo === undefined ? {} : { last_date_to: lastDateTo }),
        ...(status === undefined ? {} : { status }),
      };
      return jobToApi(await db.update(serviceToken, 'search_jobs', { id: `eq.${id}` }, patch));
    },

    /** Adds one row to search_job_runs. */
    async recordRun(serviceToken, run) {
      const row = await db.insert(serviceToken, 'search_job_runs', {
        job_id: run.jobId,
        user_id: run.userId,
        product_id: run.productId,
        ran_at: run.ranAt.toISOString(),
        date_from: run.from,
        date_to: run.to,
        status: run.status,
        found_count: run.foundCount ?? null,
        lead_count: run.leadCount ?? null,
        new_lead_count: run.newLeadCount ?? null,
        email_status: run.emailStatus ?? null,
        email_error: run.emailError ?? null,
        credits_spent: run.creditsSpent ?? null,
        error: run.error ?? null,
        error_status: run.errorStatus ?? null,
        duration_ms: run.durationMs ?? null,
      });
      return runToApi(row);
    },
  };
}
