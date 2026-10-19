import { Router } from 'express';
import { HttpError } from '../errors.js';

/**
 * @param {object} deps
 * @param {object} deps.accounts     accounts service (src/services/accounts.js)
 * @param {Function[]} deps.protect  auth middleware
 */
export function accountRouter({ accounts, protect }) {
  const router = Router();

  // DELETE /api/account  { "confirm": true }
  //   -> permanently deletes the signed-in user and everything they own, except their Terms
  //      acceptances. The explicit confirmation means a stray request cannot delete an account.
  router.delete('/account', ...protect, async (req, res) => {
    if (req.body?.confirm !== true) {
      throw new HttpError(400, 'Send { "confirm": true } to delete your account. This cannot be undone.', { field: 'confirm' });
    }
    await accounts.deleteUser(req.user.id); // the user from the verified token, never from the body
    res.json({ deleted: true });
  });

  return router;
}
