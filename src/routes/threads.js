import { Router } from 'express';
import { listForums } from '../forums/index.js';
import { parseSearchRequest, parseUuid, isoDay } from '../validation.js';
import { searchThreads } from '../services/perplexity.js';
import { HttpError } from '../errors.js';
import { searchCost, searchCostPerForum } from '../services/credits.js';

const bearer = (req) => (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {Function} [deps.search]     thread search, injectable for tests
 * @param {object} deps.products       products service; the search description comes from the product
 * @param {object} deps.results        results service; every search is stored under its product
 * @param {object} [deps.searchLog]    search log; every search that reaches Perplexity is recorded
 * @param {object} deps.credits        credits service; a search is paid for before it runs
 * @param {Function[]} [deps.protect]  middleware applied to the search routes (auth, rate limit)
 */
export function threadsRouter({ config, search = searchThreads, products, results, searchLog = { record: async () => false }, credits, protect = [] }) {
  const router = Router();

  router.get('/forums', (_req, res) => {
    res.json({ forums: listForums() });
  });

  const handleSearch = async (req, source, res) => {
    if (!source || typeof source !== 'object') throw new HttpError(400, 'Request must contain parameters');
    const productIdRaw = source.productId ?? source.product_id;
    if (productIdRaw === undefined || productIdRaw === '') {
      throw new HttpError(400, '"productId" is required', { field: 'productId' });
    }
    const productId = parseUuid(productIdRaw, 'productId');
    const token = bearer(req);

    // 404 if the product doesn't exist or isn't the caller's, before any Perplexity spend.
    const product = await products.get(token, productId);

    // The product's stored description drives the search. A description in the request overrides it for one call.
    const override = source.productDescription ?? source.product_description ?? source.description;
    const params = parseSearchRequest({ ...source, productDescription: override || product.description }, config);

    const logEntry = {
      productId,
      userId: req.user?.id,
      forums: params.forums.map((f) => f.id),
      threadsRequested: params.threads,
      from: isoDay(params.from),
      to: isoDay(params.to),
    };

    // Paid for up front, after the request is known to be valid and before any Perplexity spend.
    // One credit per 10 leads requested, per forum, whatever the search returns.
    const cost = searchCost({ threads: params.threads, forumCount: params.forums.length });
    const charged = await credits.spend(req.user.id, cost, 'search', { productId, forums: logEntry.forums, threads: params.threads });
    if (!charged.charged) {
      throw new HttpError(402, `Not enough credits: this search costs ${cost} and you have ${charged.balance}`, { cost, balance: charged.balance });
    }
    let balance = charged.balance;
    let refunded = 0;
    // A refund that fails is logged rather than failing the response: the search result, or its
    // error, is still what the caller needs.
    const refund = async (amount, details) => {
      try {
        balance = await credits.refund(req.user.id, amount, { productId, ...details });
        refunded += amount;
      } catch (refundErr) {
        console.error(`credit refund of ${amount} for user ${req.user.id} failed:`, refundErr?.message ?? refundErr);
      }
    };

    const searchDate = new Date();
    let found;
    try {
      found = await search({ ...params, config, user: req.user });
    } catch (err) {
      await searchLog.record(token, { ...logEntry, status: 'error', error: err?.message, errorStatus: err?.status, diagnostics: err?.diagnostics });
      await refund(cost, { refundFor: 'search', reason: 'search failed' });
      throw err;
    }
    // Logged before the results are saved, so the search stays on record even if saving fails.
    await searchLog.record(token, { ...logEntry, status: 'ok', returnedCount: found.threads.length, diagnostics: found.diagnostics });

    // A forum whose call failed returned nothing, so its share is given back.
    const failedForums = (found.meta?.failedForums ?? []).map((f) => f.forum);
    if (failedForums.length > 0) {
      await refund(searchCostPerForum({ threads: params.threads }) * failedForums.length, { refundFor: 'search', reason: 'forum failed', forums: failedForums });
    }

    const stored = await results.save(token, productId, found.threads, { searchDate });
    const idByLink = new Map(stored.map((r) => [r.link, r.id]));
    const threads = found.threads.map((t) => ({ id: idByLink.get(t.url) ?? null, ...t }));
    // A link stored for the first time is a new lead; one already under the product was found again.
    const newCount = stored.filter((r) => r.isNew).length;

    res.json({
      query: {
        productId,
        productName: product.name,
        productDescription: params.productDescription,
        forums: params.forums.map((f) => f.id),
        threads: params.threads,
        from: isoDay(params.from),
        to: isoDay(params.to),
        days: params.days,
      },
      count: threads.length,
      threads,
      saved: { productId, count: stored.length, newCount, existingCount: stored.length - newCount, searchDate: searchDate.toISOString() },
      credits: { spent: cost - refunded, refunded, balance },
      meta: found.meta,
    });
  };

  // POST /api/threads  { "productId": "<uuid>", "forum": "reddit" | ["reddit","hackernews"] | "all",
  //                      "threads": 10, "from": "2026-08-01", "to": "2026-08-31" }   (or "days": 7)
  router.post('/threads', ...protect, async (req, res) => handleSearch(req, req.body, res));

  // GET /api/threads?productId=...&forum=reddit,hackernews&threads=10&from=2026-08-01&to=2026-08-31
  router.get('/threads', ...protect, async (req, res) => handleSearch(req, req.query, res));

  return router;
}
