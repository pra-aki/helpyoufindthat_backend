import { Router } from 'express';
import { parseErrorReport } from '../validation.js';
import { HttpError } from '../errors.js';

/**
 * Reports from the app's Report Error action. Users can send them but never read them back: the
 * owner reads error_reports directly in Supabase. Stored with the service key, since no user may
 * write the table.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.db           Supabase REST client
 * @param {Function[]} deps.protect  auth and the report rate limit
 */
export function errorReportsRouter({ config, db, protect }) {
  const router = Router();
  const serviceToken = config.supabase.serviceRoleKey;

  // POST /api/error-reports  { "message": "...", "page": "/dashboard/products/...", "error": "...", "details": { } }
  router.post('/error-reports', ...protect, async (req, res) => {
    const report = parseErrorReport(req.body);
    if (!serviceToken) throw new HttpError(500, 'Server is missing SUPABASE_SERVICE_ROLE_KEY; error reports are not configured');
    const row = await db.insert(serviceToken, 'error_reports', {
      user_id: req.user.id, // from the verified token, never from the request
      message: report.message,
      page: report.page,
      error: report.error,
      details: report.details,
      user_agent: (req.get('user-agent') ?? '').slice(0, 500) || null,
    });
    res.status(201).json({ report: { id: row.id, createdAt: row.created_at } });
  });

  return router;
}
