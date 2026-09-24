import { Router } from 'express';
import { parseJobRequest, parseJobsQuery, parseRunsQuery, parseUuid, isoDay } from '../validation.js';
import { HttpError } from '../errors.js';
import { nextRunAtHour } from '../jobs/runner.js';

const bearer = (req) => (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/**
 * Scheduled daily searches.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.products     products service; a job belongs to one of the caller's products
 * @param {object} deps.jobs         jobs service (src/services/jobs.js)
 * @param {Function[]} deps.protect  auth middleware
 */
export function jobsRouter({ config, products, jobs, protect }) {
  const router = Router();

  // Users can read their jobs but not write them: a job has limits and spends Perplexity credit
  // daily, so only this backend creates and cancels jobs, with the service key, after its checks.
  const serviceToken = config.supabase.serviceRoleKey;
  const requireServiceKey = () => {
    if (!serviceToken) throw new HttpError(500, 'Server is missing SUPABASE_SERVICE_ROLE_KEY; scheduled searches are not configured');
  };

  // POST /api/jobs  { "productId": "<uuid>", "forum": "all", "endDate": "2026-10-17", "threads": 10, "minScore": 0.8, "email": "..." }
  //   -> schedules a search every day from today until endDate. Leads scoring at least minScore are
  //      stored under the product, and new ones are emailed. Nothing is searched until the runner's next pass.
  router.post('/jobs', ...protect, async (req, res) => {
    const source = req.body;
    if (!source || typeof source !== 'object') throw new HttpError(400, 'Request body must be a JSON object');
    const productIdRaw = source.productId ?? source.product_id;
    if (productIdRaw === undefined || productIdRaw === '') throw new HttpError(400, '"productId" is required', { field: 'productId' });
    const productId = parseUuid(productIdRaw, 'productId');
    const input = parseJobRequest(source, config);
    requireServiceKey();
    const token = bearer(req);

    await products.get(token, productId); // 404 if it doesn't exist or isn't the caller's

    const email = input.email ?? req.user?.email;
    if (!email) throw new HttpError(400, 'Your account has no email address; pass "email" in the request', { field: 'email' });

    const active = await jobs.countActive(token);
    if (active >= config.jobs.maxActivePerUser) {
      throw new HttpError(400, `You already have ${active} active jobs; the limit is ${config.jobs.maxActivePerUser}. Cancel one first.`, { activeJobs: active, maxActiveJobs: config.jobs.maxActivePerUser });
    }

    const job = await jobs.create(serviceToken, req.user, {
      productId,
      email,
      forums: input.forums,
      threads: input.threads,
      minScore: input.minScore,
      startDate: isoDay(input.startDate),
      endDate: isoDay(input.endDate),
      // Jobs only run in the daily slot, so a new job's first run is the next one. Booking it there
      // makes nextRunAt the time it will actually run, rather than the moment it was created.
      nextRunAt: nextRunAtHour(config.jobs.runAtHour, new Date()),
    });
    res.status(201).json({ job });
  });

  // GET /api/jobs?productId=...&status=active  -> the caller's jobs, newest first
  router.get('/jobs', ...protect, async (req, res) => {
    const filter = parseJobsQuery(req.query);
    res.json({ jobs: await jobs.list(bearer(req), filter) });
  });

  // GET /api/jobs/:id
  router.get('/jobs/:id', ...protect, async (req, res) => {
    const id = parseUuid(req.params.id);
    res.json({ job: await jobs.get(bearer(req), id) });
  });

  // DELETE /api/jobs/:id  -> cancels the job; it stays listed with status "cancelled" and keeps its run history
  router.delete('/jobs/:id', ...protect, async (req, res) => {
    const id = parseUuid(req.params.id);
    requireServiceKey();
    res.json({ job: await jobs.cancel(bearer(req), id, { serviceToken, userId: req.user.id }) });
  });

  // GET /api/jobs/:id/runs?limit=30&offset=0  -> what each run found and whether the email went out, newest first
  router.get('/jobs/:id/runs', ...protect, async (req, res) => {
    const id = parseUuid(req.params.id);
    const page = parseRunsQuery(req.query);
    const token = bearer(req);
    await jobs.get(token, id); // 404 if it isn't the caller's
    const { runs, total } = await jobs.listRuns(token, id, page);
    res.json({ jobId: id, runs, count: runs.length, total, limit: page.limit, offset: page.offset });
  });

  return router;
}
