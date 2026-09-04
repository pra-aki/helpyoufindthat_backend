import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
if (!config.perplexity.apiKey) {
  console.warn('PERPLEXITY_API_KEY is not set; /api/threads will return 500 until it is.');
}
if (!config.supabase.url) {
  console.warn('SUPABASE_URL is not set; /api/threads will reject every request until it is.');
}
if (config.cors.origins.length === 0) {
  console.warn('CORS_ORIGINS is not set; browsers on any origin may call this API (they still need a valid token).');
}

const app = createApp({ config });
app.listen(config.port, () => {
  console.log(`helpyoufindthat backend listening on http://localhost:${config.port}`);
});
