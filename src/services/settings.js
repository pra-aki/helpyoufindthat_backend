/**
 * Account-level settings. A user with no stored row has every setting at its default, so a new
 * account needs nothing written until it changes something.
 */
export const DEFAULT_SETTINGS = Object.freeze({ jobLeadEmails: true });

const toApi = (row) => ({
  jobLeadEmails: row?.job_lead_emails ?? DEFAULT_SETTINGS.jobLeadEmails,
});

export function createSettingsService(db) {
  return {
    /** The caller's settings, read with their token; defaults when they have never saved any. */
    async get(token) {
      const rows = await db.select(token, 'user_settings', { select: '*', limit: '1' });
      return toApi(rows?.[0]);
    },

    /** Saves the given settings for the caller, as themselves, leaving the others as they are. */
    async update(token, userId, { jobLeadEmails }) {
      const row = { user_id: userId };
      if (jobLeadEmails !== undefined) row.job_lead_emails = jobLeadEmails;
      const [stored] = await db.upsert(token, 'user_settings', [row], { onConflict: 'user_id' });
      return toApi(stored);
    },

    /** For the job runner: whether this user wants job emails, read with the service key. */
    async jobLeadEmailsEnabled(serviceToken, userId) {
      const rows = await db.select(serviceToken, 'user_settings', { select: 'job_lead_emails', user_id: `eq.${userId}`, limit: '1' });
      return rows?.[0]?.job_lead_emails ?? DEFAULT_SETTINGS.jobLeadEmails;
    },
  };
}
