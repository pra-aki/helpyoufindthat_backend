import { Router } from 'express';
import { parseProductRequest, parseUuid } from '../validation.js';

const bearer = (req) => (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/**
 * @param {object} deps
 * @param {object} deps.products     products service (src/services/products.js)
 * @param {Function[]} deps.protect  auth middleware
 */
export function productsRouter({ products, protect }) {
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

  return router;
}
