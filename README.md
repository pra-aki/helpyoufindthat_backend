# helpyoufindthat backend

Express API that finds public forum threads where people are looking for a solution like a given product. Search is done through [Perplexity's Sonar API](https://docs.perplexity.ai/).

## Setup

```bash
npm install
cp .env.example .env   # set PERPLEXITY_API_KEY and SUPABASE_URL
npm start              # http://localhost:3000
```

`npm run dev` restarts on file changes. `npm test` runs the test suite (no network or API key needed).

## Authentication

`/api/threads` is meant to be called from a browser by users who have signed in with Supabase Auth. Send the user's Supabase access token as a bearer token:

```js
const { data: { session } } = await supabase.auth.getSession();
const res = await fetch('https://helpyoufindthat-backend.onrender.com/api/threads', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
  body: JSON.stringify({ productDescription: '...', forum: 'reddit' }),
});
```

The server verifies the token's signature against the project's public JWKS endpoint (`SUPABASE_URL/auth/v1/.well-known/jwks.json`), plus its issuer, audience, and expiry. No shared secret is involved, so nothing sensitive ships to the browser. Missing or invalid tokens get 401; anonymous Supabase sessions get 403.

### Testing by hand before the front end has sign-in

```bash
npm run token -- you@example.com 'a-password' --signup   # creates the user; drop --signup afterwards
TOKEN=$(npm run -s token -- you@example.com 'a-password')
curl -s http://localhost:3000/api/threads -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"productDescription":"An app that reminds small-business owners to follow up with leads","forum":"reddit","threads":5,"days":7}'
```

This needs `SUPABASE_ANON_KEY` in `.env` (the project's public client key, found under Project Settings > API Keys). If email confirmation is enabled in your Supabase auth settings, confirm the test user in the dashboard before signing in.

Each user is limited to `RATE_LIMIT_PER_MINUTE` searches per minute (default 20); over that returns 429 with a `Retry-After` header. `/health` and `/api/forums` are public.

Set `CORS_ORIGINS` to your front end's origin(s) in production. When it's empty any origin is accepted, which is convenient for local development and safe only because the token, not the origin, is what grants access.

## API

### `GET /api/forums`

Lists supported forums with their ids, aliases, and searched domains.

### `POST /api/threads` (or `GET /api/threads?...`)

| Parameter | Required | Default | Notes |
|---|---|---|---|
| `productDescription` | yes | | What the product does. Max 2000 chars. Also accepted as `product_description` or `description`. |
| `forum` | yes | | A forum id, a JSON array of ids, a comma-separated string, or `"all"`. Ids: `reddit`, `facebook-groups`, `quora`, `linkedin-groups`, `hackernews`, `x`. Case-insensitive; aliases like `Hacker News`, `hacknews`, `twitter`, `facebook` also work. Also accepted as `forums` / `forumName` / `forum_name`. |
| `threads` | no | 10 | Max number of threads to return in total, across all requested forums (1 to 50). Also accepted as `x` or `maxThreads`. |
| `from` | no | | First day to include, `YYYY-MM-DD` (UTC). Also `startDate` / `start_date`. |
| `to` | no | today | Last day to include, `YYYY-MM-DD`, inclusive. Also `endDate` / `end_date`. Cannot be in the future. |
| `days` | no | 1 | Shortcut when `from` is omitted: search the N days ending at `to`. Also accepted as `y`. |

The range from `from` to `to` may not exceed one year (365 days). Examples: `"days": 7` searches the last week; `"from": "2026-08-01", "to": "2026-08-31"` searches August; `"from": "2026-06-01"` searches from June until today.

```bash
curl -s http://localhost:3000/api/threads \
  -H 'content-type: application/json' \
  -d '{"productDescription":"An app that reminds small-business owners to follow up with leads","forum":"reddit","threads":5,"days":7}'
```

Search several forums in one call (each thread's `source` says where it came from):

```bash
curl -s http://localhost:3000/api/threads -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"productDescription":"...","forum":["reddit","hackernews","x"],"threads":10,"days":7}'
# or  "forum":"all"      or, with GET,  ?forum=reddit,hackernews
```

Response:

```json
{
  "query": { "productDescription": "...", "forums": ["reddit"], "threads": 5, "from": "2026-08-28", "to": "2026-09-04", "days": 7 },
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
  "meta": { "model": "sonar-pro", "searchedForums": ["reddit"], "searchedDomains": ["reddit.com"], "from": "2026-08-28", "to": "2026-09-04", "usage": { }, "rawResultCount": 8 }
}
```

Errors are JSON: `{ "error": { "message": "...", "details": { } } }` with 400 for bad input, 401/403 for auth failures, 429 for rate limits (yours or Perplexity's), 502/504 for upstream failures, and 500 if required configuration is missing.

### `POST /api/products`

Stores a product for the signed-in user. Requires the Supabase bearer token.

| Field | Required | Notes |
|---|---|---|
| `name` | yes | up to 200 chars. Also `productName` / `product_name`. |
| `description` | yes | up to 2000 chars. Also `productDescription` / `product_description`. |
| `website` | no | normalised to a full URL (`acme.com` becomes `https://acme.com/`). Also `productWebsite` / `product_website`. |

```bash
curl -s https://helpyoufindthat-backend.onrender.com/api/products \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"FollowUp","website":"followup.app","description":"Reminds small-business owners to follow up with leads"}'
```

Returns `201` with `{ "product": { "id", "name", "website", "description", "userId", "createdAt", "updatedAt" } }`.

### `GET /api/products` and `GET /api/products/:id`

List the caller's products (newest first) or fetch one. Products belong to the user who created them; row-level security in Postgres means other users' products are invisible, so a foreign id returns 404.

The backend talks to Supabase's REST endpoint with the caller's own token, so no privileged database key is stored on the server. This needs `SUPABASE_ANON_KEY` (the publishable key) in the environment.

## How search works

Each request is exactly one Perplexity chat completion, whether it covers one forum or all of them, with:

- `search_domain_filter` restricted to the requested forums' domains
- `web_search_options.search_context_size` from `PERPLEXITY_SEARCH_CONTEXT` (default `medium`; `high` gathers more sources per call, useful for multi-forum searches, at a higher cost)
- `search_after_date_filter` and `search_before_date_filter` set from the requested range (Perplexity does not allow combining these with `search_recency_filter`)
- a JSON-schema `response_format` asking for ranked threads with a relevance score

Results are then filtered to URLs that are on one of the requested forums and look like a thread there (not an index or profile page), tagged with that forum as `source`, deduplicated, sorted by relevance, and cut to `threads`.

The `relevanceScore` is the model's own 0 to 1 judgement of how strongly the poster is seeking something like the product. It's a useful sort key, not a calibrated probability, and Perplexity's search layer exposes no score of its own. When one call spans several forums, larger sites tend to contribute more sources; use per-forum calls when you want depth on a specific site. If the model returns unusable JSON the raw `search_results` are used as a fallback.

## Adding a forum

1. Create `src/forums/<name>.js` exporting `{ id, name, aliases, domains, threadHint, isThreadUrl }`. See `src/forums/reddit.js`.
2. Import it in `src/forums/index.js` and append it to the `forums` array.
3. Add a case to `test/forums.test.js`.

## Configuration

| Variable | Default | |
|---|---|---|
| `PERPLEXITY_API_KEY` | | required |
| `SUPABASE_URL` | | required; the project URL, e.g. `https://abc.supabase.co` |
| `SUPABASE_ANON_KEY` | | required for `/api/products`; the publishable key (public) |
| `CORS_ORIGINS` | (any) | comma-separated allowed browser origins |
| `RATE_LIMIT_PER_MINUTE` | `20` | per user |
| `PERPLEXITY_MODEL` | `sonar-pro` | `sonar` is cheaper and faster |
| `PERPLEXITY_SEARCH_CONTEXT` | `medium` | `low`, `medium`, or `high` |
| `PERPLEXITY_BASE_URL` | `https://api.perplexity.ai` | override for testing against a mock |
| `PERPLEXITY_TIMEOUT_MS` | `60000` | |
| `PORT` | `3000` | |
