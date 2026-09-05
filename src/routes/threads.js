import { Router } from 'express';
import { listForums } from '../forums/index.js';
import { parseSearchRequest, parseUuid, isoDay } from '../validation.js';
import { searchThreads } from '../services/perplexity.js';
import { HttpError } from '../errors.js';

const bearer = (req) => (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {Function} [deps.search]     thread search, injectable for tests
 * @param {object} deps.products       products service; the search description comes from the product
 * @param {object} deps.results        results service; every search is stored under its product
 * @param {Function[]} [deps.protect]  middleware applied to the search routes (auth, rate limit)
 */
export function threadsRouter({ config, search = searchThreads, products, results, protect = [] }) {
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

    const searchDate = new Date();
    const found = await search({ ...params, config, user: req.user });
    const stored = await results.save(token, productId, found.threads, { searchDate });
    const idByLink = new Map(stored.map((r) => [r.link, r.id]));
    const threads = found.threads.map((t) => ({ id: idByLink.get(t.url) ?? null, ...t }));

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
      saved: { productId, count: stored.length, searchDate: searchDate.toISOString() },
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
