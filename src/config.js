const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
    },
    supabase: {
      url: supabaseUrl,
      issuer: supabaseUrl ? `${supabaseUrl}/auth/v1` : '',
      jwksUrl: supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : '',
      audience: env.SUPABASE_JWT_AUDIENCE ?? 'authenticated',
    },
    cors: {
      // Comma-separated list of allowed browser origins. Empty means any origin.
      origins: list(env.CORS_ORIGINS),
    },
    rateLimit: {
      perMinute: num(env.RATE_LIMIT_PER_MINUTE, 20),
    },
    defaults: { threads: 10, days: 1 },
    limits: { maxThreads: 50, maxDays: 365, maxDescriptionLength: 2000 },
  };
}
