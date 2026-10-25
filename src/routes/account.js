import { Router } from 'express';
import { HttpError } from '../errors.js';

/**
 * @param {object} deps
 * @param {object} deps.accounts       accounts service (src/services/accounts.js)
 * @param {object} deps.credits        credits service; an account holding paid credits is not deleted here
 * @param {string} deps.supportEmail   where to send people whose account cannot be deleted here
 * @param {Function[]} deps.protect    auth middleware
 */
export function accountRouter({ accounts, credits, supportEmail, protect }) {
  const router = Router();

  // DELETE /api/account  { "confirm": true }
  //   -> permanently deletes the signed-in user and everything they own, except their Terms
  //      acceptances. The explicit confirmation means a stray request cannot delete an account.
  router.delete('/account', ...protect, async (req, res) => {
    if (req.body?.confirm !== true) {
      throw new HttpError(400, 'Send { "confirm": true } to delete your account. This cannot be undone.', { field: 'confirm' });
    }
    // Paid credits are money the user may expect back, so support handles those deletions.
    const { paid } = await credits.balance(req.user.id);
    if (paid > 0) {
      throw new HttpError(409, `Your account has ${paid} paid credit${paid === 1 ? '' : 's'}, so it can't be deleted here. Email ${supportEmail} and we'll take care of it.`, { paidCredits: paid, supportEmail });
    }
    await accounts.deleteUser(req.user.id); // the user from the verified token, never from the body
    res.json({ deleted: true });
  });

  return router;
}
