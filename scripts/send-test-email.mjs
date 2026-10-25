#!/usr/bin/env node
/**
 * Sends one job lead email to an address, built by the same code the daily jobs use, so its look
 * can be checked in a real inbox. The subject starts with [Test].
 *
 *   npm run send-test-email -- --to you@example.com --leads leads.json
 *
 * leads.json is { product: { name }, job: { id, productId, minScore, endDate }, leads: [ ... ] },
 * with leads shaped like a search's threads (title, url, source, relevanceScore, postedAt, asksFor,
 * summary). Needs RESEND_API_KEY and EMAIL_FROM in .env; keep them out of git and out of chat.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createMailer } from '../src/services/mailer.js';
import { leadsEmail } from '../src/jobs/email.js';
import { parseEmail } from '../src/validation.js';

const { values } = parseArgs({ options: { to: { type: 'string' }, leads: { type: 'string' } } });
if (!values.to || !values.leads) {
  console.error('usage: npm run send-test-email -- --to you@example.com --leads leads.json');
  process.exit(2);
}

const config = loadConfig();
const mailer = createMailer(config.email);
if (!mailer.configured) {
  console.error('RESEND_API_KEY and EMAIL_FROM must be set in .env to send email.');
  process.exit(2);
}

const to = parseEmail(values.to, 'to');
const { product, job, leads } = JSON.parse(readFileSync(values.leads, 'utf8'));
const now = new Date();
const email = leadsEmail({ product, job, leads, from: new Date(now.getTime() - 7 * 86_400_000), to: now, appUrl: config.appUrl });

try {
  const { id } = await mailer.send({ to, subject: `[Test] ${email.subject}`, text: email.text, html: email.html });
  console.log(`sent "[Test] ${email.subject}" to ${to} (Resend id ${id})`);
} catch (err) {
  console.error(`could not send: ${err.message}${err.details?.reason ? ` (${err.details.reason})` : ''}`);
  process.exit(1);
}
