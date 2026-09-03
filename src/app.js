import express from 'express';
import { HttpError } from './errors.js';
import { threadsRouter } from './routes/threads.js';

export function createApp({ config, search } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', threadsRouter({ config, search }));

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

  return app;
}
