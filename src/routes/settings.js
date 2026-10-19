import { Router } from 'express';
import { HttpError } from '../errors.js';

const bearer = (req) => (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/**
 * Validates a settings change. Every field is optional, but at least one must be given, and an
 * unknown field is an error rather than silently ignored.
 */
export function parseSettingsUpdate(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new HttpError(400, 'Request body must be a JSON object');
  const known = ['jobLeadEmails'];
  const unknown = Object.keys(source).filter((k) => !known.includes(k));
  if (unknown.length > 0) throw new HttpError(400, `Unknown setting "${unknown[0]}"`, { field: unknown[0], known });
  if (source.jobLeadEmails !== undefined && typeof source.jobLeadEmails !== 'boolean') {
    throw new HttpError(400, '"jobLeadEmails" must be true or false', { field: 'jobLeadEmails' });
  }
  if (source.jobLeadEmails === undefined) throw new HttpError(400, 'Send at least one setting to change', { known });
  return { jobLeadEmails: source.jobLeadEmails };
}

/**
 * @param {object} deps
 * @param {object} deps.settings     settings service (src/services/settings.js)
 * @param {Function[]} deps.protect  auth middleware
 */
export function settingsRouter({ settings, protect }) {
  const router = Router();

  // GET /api/settings  -> { settings: { jobLeadEmails } }
  router.get('/settings', ...protect, async (req, res) => {
    res.json({ settings: await settings.get(bearer(req)) });
  });

  // PATCH /api/settings  { "jobLeadEmails": false }  -> the saved settings
  router.patch('/settings', ...protect, async (req, res) => {
    const change = parseSettingsUpdate(req.body);
    res.json({ settings: await settings.update(bearer(req), req.user.id, change) });
  });

  return router;
}
