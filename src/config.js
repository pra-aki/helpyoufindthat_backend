// Like num, but 0 is a valid value; used for delays that can legitimately be turned off.
const numOrZero = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// A whole hour of the day, 0 to 23. Unlike num, 0 (midnight) is valid.
const hour = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
};

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  const supabaseUrl = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  return {
    port: num(env.PORT, 3000),
    perplexity: {
      apiKey: env.PERPLEXITY_API_KEY,
      baseUrl: (env.PERPLEXITY_BASE_URL ?? 'https://api.perplexity.ai').replace(/\/+$/, ''),
      model: env.PERPLEXITY_MODEL ?? 'sonar-pro',
      timeoutMs: num(env.PERPLEXITY_TIMEOUT_MS, 60_000),
      // Perplexity's rate limit is per account, roughly one request every 1.2s at the lowest tier,
      // so calls are queued and released one at a time. 0 sends them without spacing.
      minIntervalMs: numOrZero(env.PERPLEXITY_MIN_INTERVAL_MS, 1200),
      // A call that would wait longer than this fails fast instead of hanging.
      maxQueueWaitMs: numOrZero(env.PERPLEXITY_MAX_QUEUE_WAIT_MS, 30_000),
      // How much web context Perplexity gathers per call: low | medium | high. High costs more but
      // surfaces more sources, which matters when one call covers several forums.
      searchContextSize: ['low', 'medium', 'high'].includes(env.PERPLEXITY_SEARCH_CONTEXT) ? env.PERPLEXITY_SEARCH_CONTEXT : 'medium',
    },
    supabase: {
      url: supabaseUrl,
      issuer: supabaseUrl ? `${supabaseUrl}/auth/v1` : '',
      jwksUrl: supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : '',
      audience: env.SUPABASE_JWT_AUDIENCE ?? 'authenticated',
      restUrl: supabaseUrl ? `${supabaseUrl}/rest/v1` : '',
      // Publishable (anon) key. Public; PostgREST needs it alongside the user's token.
      anonKey: env.SUPABASE_ANON_KEY ?? '',
      // Service-role key. Secret; bypasses row-level security. Used only by the job runner, which
      // searches on behalf of users who are not signed in at the time.
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    },
    email: {
      // Transactional email through Resend's HTTP API. Both must be set for job emails to go out.
      resendApiKey: env.RESEND_API_KEY ?? '',
      from: env.EMAIL_FROM ?? '',
      baseUrl: (env.RESEND_BASE_URL ?? 'https://api.resend.com').replace(/\/+$/, ''),
    },
    jobs: {
      // Jobs run daily at this UTC hour, so a user knows when the email arrives and the searches
      // land off-peak. 0 to 23.
      runAtHour: hour(env.SEARCH_JOBS_RUN_AT_HOUR, 3),
      // The runner is on unless explicitly disabled, for deployments that trigger `npm run jobs`
      // from an external scheduler instead.
      enabled: env.SEARCH_JOBS_ENABLED !== 'false',
      maxActivePerUser: num(env.SEARCH_JOBS_MAX_ACTIVE_PER_USER, 5),
      // Due jobs are fetched this many at a time; the runner keeps going until none are left.
      batchSize: num(env.SEARCH_JOBS_BATCH_SIZE, 20),
      defaultMinScore: 0.8,
    },
    cors: {
      // Comma-separated list of allowed browser origins. Empty means any origin.
      origins: list(env.CORS_ORIGINS),
    },
    rateLimit: {
      perMinute: num(env.RATE_LIMIT_PER_MINUTE, 20),
    },
    defaults: { threads: 10, days: 1 },
    limits: { maxThreads: 50, maxDays: 92, maxDescriptionLength: 2000 }, // 92 days covers any three calendar months
  };
}
