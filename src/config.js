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
