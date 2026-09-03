# helpyoufindthat backend

Express API that finds public forum threads where people are looking for a solution like a given product. Search is done through [Perplexity's Sonar API](https://docs.perplexity.ai/).

## Setup

```bash
npm install
cp .env.example .env   # then put your Perplexity key in PERPLEXITY_API_KEY
npm start              # http://localhost:3000
```

`npm run dev` restarts on file changes. `npm test` runs the test suite (no network or API key needed).

## API

### `GET /api/forums`

Lists supported forums with their ids, aliases, and searched domains.

### `POST /api/threads` (or `GET /api/threads?...`)

| Parameter | Required | Default | Notes |
|---|---|---|---|
| `productDescription` | yes | | What the product does. Max 2000 chars. Also accepted as `product_description` or `description`. |
| `forum` | yes | | One of `reddit`, `facebook-groups`, `quora`, `linkedin-groups`, `hackernews`, `x`. Case-insensitive; aliases like `Hacker News`, `hacknews`, `twitter`, `facebook` also work. Also accepted as `forumName` / `forum_name`. |
| `threads` | no | 10 | Max number of threads to return (1 to 50). Also accepted as `x` or `maxThreads`. |
| `days` | no | 1 | Only threads posted within the last N days (1 to 365). Also accepted as `y`. |

```bash
curl -s http://localhost:3000/api/threads \
  -H 'content-type: application/json' \
  -d '{"productDescription":"An app that reminds small-business owners to follow up with leads","forum":"reddit","threads":5,"days":7}'
```

Response:

```json
{
  "query": { "productDescription": "...", "forum": "reddit", "threads": 5, "days": 7 },
  "count": 3,
  "threads": [
    {
      "title": "What CRM do you use for follow-ups?",
      "url": "https://www.reddit.com/r/smallbusiness/comments/.../",
      "summary": "Poster runs a landscaping company and keeps forgetting to call leads back.",
      "whyRelevant": "Explicitly asking for a follow-up reminder tool.",
      "postedAt": "2026-08-30",
      "relevanceScore": 0.92,
      "source": "reddit"
    }
  ],
  "meta": { "model": "sonar-pro", "searchedDomains": ["reddit.com"], "after": "...", "usage": { }, "rawResultCount": 8 }
}
```

Errors are JSON: `{ "error": { "message": "...", "details": { } } }` with 400 for bad input, 429 when Perplexity rate-limits, 502/504 for upstream failures, and 500 if the API key is missing.

## How search works

For each request the server makes one Perplexity chat completion with:

- `search_domain_filter` restricted to the forum's domains
- `search_after_date_filter` and `search_recency_filter` derived from `days`
- a JSON-schema `response_format` asking for ranked threads with a relevance score

Results are then filtered to URLs that are actually on the forum's domain and look like a thread (not an index or profile page), deduplicated, sorted by relevance, and cut to `threads`. If the model returns unusable JSON the raw `search_results` are used as a fallback.

## Adding a forum

1. Create `src/forums/<name>.js` exporting `{ id, name, aliases, domains, threadHint, isThreadUrl }`. See `src/forums/reddit.js`.
2. Import it in `src/forums/index.js` and append it to the `forums` array.
3. Add a case to `test/forums.test.js`.

## Configuration

| Variable | Default | |
|---|---|---|
| `PERPLEXITY_API_KEY` | | required |
| `PERPLEXITY_MODEL` | `sonar-pro` | `sonar` is cheaper and faster |
| `PERPLEXITY_BASE_URL` | `https://api.perplexity.ai` | override for testing against a mock |
| `PERPLEXITY_TIMEOUT_MS` | `60000` | |
| `PORT` | `3000` | |
