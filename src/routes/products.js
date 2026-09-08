import { Router } from 'express';
import { parseProductRequest, parseUuid, parseResultsQuery } from '../validation.js';

const bearer = (req) => (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/**
 * @param {object} deps
 * @param {object} deps.products     products service (src/services/products.js)
 * @param {object} deps.results      results service (src/services/results.js)
 * @param {Function[]} deps.protect  auth middleware
 */
export function productsRouter({ products, results, protect }) {
  const router = Router();

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
