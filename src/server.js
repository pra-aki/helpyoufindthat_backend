import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createMailer } from './services/mailer.js';
import { createJobRunner } from './jobs/runner.js';

const config = loadConfig();
if (!config.perplexity.apiKey) {
  console.warn('PERPLEXITY_API_KEY is not set; /api/threads will return 500 until it is.');
}
if (!config.supabase.url) {
  console.warn('SUPABASE_URL is not set; authenticated routes will reject every request until it is.');
}
if (!config.supabase.anonKey) {
  console.warn('SUPABASE_ANON_KEY is not set; /api/products will return 500 until it is.');
}
if (config.cors.origins.length === 0) {
  console.warn('CORS_ORIGINS is not set; browsers on any origin may call this API (they still need a valid token).');
}
if (!config.supabase.serviceRoleKey) {
  console.warn('SUPABASE_SERVICE_ROLE_KEY is not set; scheduled search jobs can neither be created nor run.');
}
const mailer = createMailer(config.email);
if (!mailer.configured) {
  console.warn('RESEND_API_KEY or EMAIL_FROM is not set; scheduled search jobs will store leads but send no email.');
}

const app = createApp({ config });
app.listen(config.port, () => {
  console.log(`helpyoufindthat backend listening on http://localhost:${config.port}`);
});

// Jobs run daily at SEARCH_JOBS_RUN_AT_HOUR, plus one catch-up pass now for anything left
// overdue. SEARCH_JOBS_ENABLED=false turns this off; use `npm run jobs` from a scheduler instead.
const runner = createJobRunner({ config, mailer, ...app.locals.services });
if (runner.start()) {
  console.log(`scheduled searches run daily at ${String(config.jobs.runAtHour).padStart(2, '0')}:00 UTC`);
}
