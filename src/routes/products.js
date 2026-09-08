import { Router } from 'express';
import { parseProductRequest, parseUuid, parseUuidList, parseResultsQuery, parseWebsite } from '../validation.js';
import { describeWebsite, composeGeneralReply } from '../services/perplexity.js';

const bearer = (req) => (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.products       products service (src/services/products.js)
 * @param {object} deps.results        results service (src/services/results.js)
 * @param {Function} [deps.describe]   website description generator, injectable for tests
 * @param {Function} [deps.compose]    general reply composer, injectable for tests
 * @param {Function[]} deps.protect    auth middleware
 * @param {Function[]} [deps.limited]  auth + rate limit, for routes that call Perplexity
 */
export function productsRouter({ config, products, results, describe = describeWebsite, compose = composeGeneralReply, protect, limited = protect }) {
  const router = Router();

  // POST /api/products/describe  { "website": "https://..." }
  //   -> a generated name, description, audience, and customer problem, read from the site by Perplexity.
  //      Nothing is saved; use the result to create or edit a product.
  router.post('/products/describe', ...limited, async (req, res) => {
    const website = parseWebsite(req.body?.website ?? req.body?.url ?? req.body?.productWebsite);
    res.json(await describe({ website, config }));
  });

  // POST /api/products  { "name": "...", "website": "https://...", "description": "..." }
  router.post('/products', ...protect, async (req, res) => {
    const input = parseProductRequest(req.body);
    const product = await products.create(bearer(req), req.user, input);
    res.status(201).json({ product });
  });

  // GET /api/products  -> the caller's products, newest first
  router.get('/products', ...protect, async (req, res) => {
    res.json({ products: await products.list(bearer(req)) });
  });

  // GET /api/products/:id
  router.get('/products/:id', ...protect, async (req, res) => {
    const id = parseUuid(req.params.id);
    res.json({ product: await products.get(bearer(req), id) });
  });

  // PATCH /api/products/:id  { "name": "...", "website": "https://...", "description": "..." }
  //   -> updates the product in place; its id does not change
  router.patch('/products/:id', ...protect, async (req, res) => {
    const id = parseUuid(req.params.id);
    const input = parseProductRequest(req.body);
    const token = bearer(req);
    await products.get(token, id); // 404 if it doesn't exist or isn't the caller's
    const product = await products.update(token, id, input);
    res.json({ product });
  });

  // POST /api/products/:id/reply   -> composes the product's general reply and stores it on the product
  router.post('/products/:id/reply', ...limited, async (req, res) => {
    const id = parseUuid(req.params.id);
    const token = bearer(req);
    const product = await products.get(token, id);
    const { reply, notes, meta } = await compose({ product, config });
    const updated = await products.setGeneralReply(token, id, reply);
    res.json({ product: updated, notes, meta });
  });

  // DELETE /api/products/:id/results/:resultId   -> deletes one lead
  router.delete('/products/:id/results/:resultId', ...protect, async (req, res) => {
    const id = parseUuid(req.params.id);
    const resultId = parseUuid(req.params.resultId, 'resultId');
    const token = bearer(req);
    await products.get(token, id);
    const deleted = await results.remove(token, id, [resultId]);
    if (deleted.length === 0) return res.status(404).json({ error: { message: 'Lead not found' } });
    res.json({ productId: id, deleted: deleted.length, ids: deleted });
  });

  // DELETE /api/products/:id/results   { "ids": ["...", "..."] }   (or ?ids=a,b,c)   -> deletes several leads
  router.delete('/products/:id/results', ...protect, async (req, res) => {
    const id = parseUuid(req.params.id);
    const ids = parseUuidList(req.body?.ids ?? req.body?.resultIds ?? req.query.ids, { name: 'ids' });
    const token = bearer(req);
    await products.get(token, id);
    const deleted = await results.remove(token, id, ids);
    const deletedSet = new Set(deleted);
    res.json({ productId: id, deleted: deleted.length, ids: deleted, notFound: ids.filter((x) => !deletedSet.has(x)) });
  });

  // GET /api/products/:id/results?limit=50&offset=0&source=reddit&minScore=0.5
  //   -> stored search results for the product, latest search first, then by score
  router.get('/products/:id/results', ...protect, async (req, res) => {
    const id = parseUuid(req.params.id);
    const page = parseResultsQuery(req.query);
    const token = bearer(req);
    await products.get(token, id); // 404 if it doesn't exist or isn't the caller's
    const { results: rows, total } = await results.list(token, id, page);
    res.json({ productId: id, results: rows, count: rows.length, total, limit: page.limit, offset: page.offset });
  });

  return router;
}
