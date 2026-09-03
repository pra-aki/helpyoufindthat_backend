const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 3000),
    perplexity: {
      apiKey: env.PERPLEXITY_API_KEY,
      baseUrl: (env.PERPLEXITY_BASE_URL ?? 'https://api.perplexity.ai').replace(/\/+$/, ''),
      model: env.PERPLEXITY_MODEL ?? 'sonar-pro',
      timeoutMs: num(env.PERPLEXITY_TIMEOUT_MS, 60_000),
    },
    defaults: { threads: 10, days: 1 },
    limits: { maxThreads: 50, maxDays: 365, maxDescriptionLength: 2000 },
  };
}
