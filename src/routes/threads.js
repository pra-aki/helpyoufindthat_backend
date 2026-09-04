import { Router } from 'express';
import { listForums } from '../forums/index.js';
import { parseSearchRequest } from '../validation.js';
import { searchThreads } from '../services/perplexity.js';

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {Function} [deps.search]     thread search, injectable for tests
 * @param {Function[]} [deps.protect]  middleware applied to the search routes (auth, rate limit)
 */
export function threadsRouter({ config, search = searchThreads, protect = [] }) {
  const router = Router();

  router.get('/forums', (_req, res) => {
    res.json({ forums: listForums() });
  });

  const handleSearch = async (req, source, res) => {
    const params = parseSearchRequest(source, config);
    const { threads, meta } = await search({ ...params, config, user: req.user });
    res.json({
      query: {
        productDescription: params.productDescription,
        forum: params.forum.id,
        threads: params.threads,
        days: params.days,
      },
      count: threads.length,
      threads,
      meta,
    });
  };

  // POST /api/threads  { "productDescription": "...", "forum": "reddit", "threads": 10, "days": 1 }
  router.post('/threads', ...protect, async (req, res) => handleSearch(req, req.body, res));

  // GET /api/threads?productDescription=...&forum=reddit&threads=10&days=1
  router.get('/threads', ...protect, async (req, res) => handleSearch(req, req.query, res));

  return router;
}
