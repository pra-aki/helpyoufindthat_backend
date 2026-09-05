import { Router } from 'express';
import { listForums } from '../forums/index.js';
import { parseSearchRequest, parseUuid, isoDay } from '../validation.js';
import { searchThreads } from '../services/perplexity.js';

const bearer = (req) => (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {Function} [deps.search]     thread search, injectable for tests
 * @param {object} deps.products       products service, used to check the product exists when saving
 * @param {object} deps.results        results service, used to store threads under a product
 * @param {Function[]} [deps.protect]  middleware applied to the search routes (auth, rate limit)
 */
export function threadsRouter({ config, search = searchThreads, products, results, protect = [] }) {
  const router = Router();

  router.get('/forums', (_req, res) => {
    res.json({ forums: listForums() });
  });

  const handleSearch = async (req, source, res) => {
    const params = parseSearchRequest(source, config);
    const productIdRaw = source.productId ?? source.product_id;
    const productId = productIdRaw === undefined || productIdRaw === '' ? null : parseUuid(productIdRaw, 'productId');
    const token = bearer(req);

    // Check the product exists (and belongs to the caller) before spending a Perplexity call.
    if (productId) await products.get(token, productId);

    const searchDate = new Date();
    let { threads, meta } = await search({ ...params, config, user: req.user });

    let saved = null;
    if (productId) {
      const stored = await results.save(token, productId, threads, { searchDate });
      const idByLink = new Map(stored.map((r) => [r.link, r.id]));
      threads = threads.map((t) => ({ id: idByLink.get(t.url) ?? null, ...t }));
      saved = { productId, count: stored.length, searchDate: searchDate.toISOString() };
    }

    res.json({
      query: {
        productDescription: params.productDescription,
        forums: params.forums.map((f) => f.id),
        threads: params.threads,
        from: isoDay(params.from),
        to: isoDay(params.to),
        days: params.days,
        productId,
      },
      count: threads.length,
      threads,
      saved,
      meta,
    });
  };

  // POST /api/threads  { "productDescription": "...", "forum": "reddit" | ["reddit","hackernews"] | "all",
  //                      "threads": 10, "from": "2026-08-01", "to": "2026-08-31",   (or "days": 7)
  //                      "productId": "<uuid>" }   (optional: store the results under that product)
  router.post('/threads', ...protect, async (req, res) => handleSearch(req, req.body, res));

  // GET /api/threads?productDescription=...&forum=reddit,hackernews&threads=10&from=2026-08-01&to=2026-08-31&productId=...
  router.get('/threads', ...protect, async (req, res) => handleSearch(req, req.query, res));

  return router;
}
