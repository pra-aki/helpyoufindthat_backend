import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
if (!config.perplexity.apiKey) {
  console.warn('PERPLEXITY_API_KEY is not set; /api/threads will return 500 until it is.');
}

const app = createApp({ config });
app.listen(config.port, () => {
  console.log(`helpyoufindthat backend listening on http://localhost:${config.port}`);
});
