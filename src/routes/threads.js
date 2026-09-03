import { Router } from 'express';
import { listForums } from '../forums/index.js';
import { parseSearchRequest } from '../validation.js';
import { searchThreads } from '../services/perplexity.js';

export function threadsRouter({ config, search = searchThreads }) {
  const router = Router();

  router.get('/forums', (_req, res) => {
    res.json({ forums: listForums() });
  });

  const handleSearch = async (source, res) => {
    const params = parseSearchRequest(source, config);
    const { threads, meta } = await search({ ...params, config });
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
  router.post('/threads', async (req, res) => handleSearch(req.body, res));

  // GET /api/threads?productDescription=...&forum=reddit&threads=10&days=1
  router.get('/threads', async (req, res) => handleSearch(req.query, res));

  return router;
}
