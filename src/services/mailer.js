import { HttpError } from '../errors.js';

/**
 * Sends email through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
 * No SDK: one POST with the API key. `configured` is false when the key or sender is missing,
 * and the job runner then records the email as not_configured instead of failing the run.
 *
 * @param {object} emailConfig  config.email from src/config.js
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 */
export function createMailer(emailConfig, { fetchImpl = fetch } = {}) {
  const { resendApiKey, from, baseUrl } = emailConfig;
  const configured = Boolean(resendApiKey && from);

  return {
    configured,

    /** Sends one message. Resolves to { id } from Resend; throws an HttpError on failure. */
    async send({ to, subject, text, html }) {
      if (!configured) throw new HttpError(500, 'Email is not configured; set RESEND_API_KEY and EMAIL_FROM');
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/emails`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, text, html }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (cause) {
        throw new HttpError(502, 'Could not reach the email service', { reason: cause?.message });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new HttpError(502, `Email service rejected the message with HTTP ${res.status}`, { reason: data?.message ?? data?.error ?? null });
      }
      return { id: data?.id ?? null };
    },
  };
}
