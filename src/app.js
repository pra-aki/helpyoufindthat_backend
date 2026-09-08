import express from 'express';
import cors from 'cors';
import { HttpError } from './errors.js';
import { threadsRouter } from './routes/threads.js';
import { productsRouter } from './routes/products.js';
import { createSupabaseRest } from './services/supabaseRest.js';
import { createProductsService } from './services/products.js';
import { createResultsService } from './services/results.js';
import { createSupabaseVerifier, requireUser } from './auth/supabase.js';
import { rateLimit } from './middleware/rateLimit.js';

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {Function} [deps.search]   injectable thread search (tests)
 * @param {Function} [deps.verify]   injectable token verifier (tests)
 * @param {object} [deps.products]   injectable products service (tests)
 * @param {object} [deps.results]    injectable results service (tests)
 * @param {Function} [deps.describe] injectable website describer (tests)
 * @param {Function} [deps.compose]  injectable general reply composer (tests)
 */
export function createApp({ config, search, verify, products, results, describe, compose } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS and forwards the client IP
  app.use(
    cors({
      origin: config.cors.origins.length ? config.cors.origins : true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '64kb' }));

  const verifyToken = verify ?? createSupabaseVerifier(config.supabase);
  const limiter = rateLimit({ perMinute: config.rateLimit.perMinute });
  const authenticate = requireUser(verifyToken);
  const protect = [authenticate, limiter];
  const db = createSupabaseRest(config.supabase);
  const productsService = products ?? createProductsService(db);
  const resultsService = results ?? createResultsService(db);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', threadsRouter({ config, search, products: productsService, results: resultsService, protect }));
  app.use('/api', productsRouter({ config, products: productsService, results: resultsService, describe, compose, protect: [authenticate], limited: protect }));

  app.use((_req, res) => {
    res.status(404).json({ error: { message: 'Not found' } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err instanceof HttpError ? err.status : err?.type === 'entity.parse.failed' ? 400 : err?.status ?? 500;
    const message = status >= 500 && !(err instanceof HttpError) ? 'Internal server error' : err.message;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: { message, ...(err.details ? { details: err.details } : {}) } });
  });

  app.locals.stop = () => limiter.stop();
  return app;
}
