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
  body: JSON.stringify({ productId: '<uuid from POST /api/products>', forum: 'reddit' }),
});
```

The server verifies the token's signature against the project's public JWKS endpoint (`SUPABASE_URL/auth/v1/.well-known/jwks.json`), plus its issuer, audience, and expiry. No shared secret is involved, so nothing sensitive ships to the browser. Missing or invalid tokens get 401; anonymous Supabase sessions get 403.

### Testing by hand before the front end has sign-in

```bash
npm run token -- you@example.com 'a-password' --signup   # creates the user; drop --signup afterwards
TOKEN=$(npm run -s token -- you@example.com 'a-password')
curl -s http://localhost:3000/api/threads -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"productId":"'$PRODUCT_ID'","forum":"reddit","threads":5,"days":7}'
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
| `productId` | yes | | UUID of one of your products (see `POST /api/products`). Its stored description drives the search, and the results are stored under it. |
| `productDescription` | no | the product's | One-off override of the description for this search only. Max 2000 chars. |
| `forum` | yes | | A forum id, a JSON array of ids, a comma-separated string, or `"all"`. Ids: `reddit`, `facebook-groups`, `quora`, `linkedin-groups`, `hackernews`, `x`. Case-insensitive; aliases like `Hacker News`, `hacknews`, `twitter`, `facebook` also work. Also accepted as `forums` / `forumName` / `forum_name`. |
| `threads` | no | 10 | How many threads to return in total, across all requested forums (1 to 50). Weaker matches fill the count with low scores rather than being left out. Also accepted as `x` or `maxThreads`. |
| `from` | no | | First day to include, `YYYY-MM-DD` (UTC). Also `startDate` / `start_date`. |
| `to` | no | today | Last day to include, `YYYY-MM-DD`, inclusive. Also `endDate` / `end_date`. Cannot be in the future. |
| `days` | no | 1 | Shortcut when `from` is omitted: search the N days ending at `to`. Also accepted as `y`. |

The range from `from` to `to` may not exceed three months (92 days). Examples: `"days": 7` searches the last week; `"from": "2026-08-01", "to": "2026-08-31"` searches August; `"from": "2026-06-01"` searches from June until today.

```bash
curl -s http://localhost:3000/api/threads \
  -H 'content-type: application/json' \
  -d '{"productId":"'$PRODUCT_ID'","forum":"reddit","threads":5,"days":7}'
```

Search several forums in one call (each thread's `source` says where it came from):

```bash
curl -s http://localhost:3000/api/threads -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"productId":"'$PRODUCT_ID'","forum":["reddit","hackernews","x"],"threads":10,"days":7}'
# or  "forum":"all"      or, with GET,  ?forum=reddit,hackernews
```

Response:

```json
{
  "query": { "productId": "...", "productName": "...", "productDescription": "...", "forums": ["reddit"], "threads": 5, "from": "2026-08-28", "to": "2026-09-04", "days": 7 },
  "count": 3,
  "threads": [
    {
      "title": "What CRM do you use for follow-ups?",
      "url": "https://www.reddit.com/r/smallbusiness/comments/.../",
      "asksFor": "a simple way to get reminded to call leads back",
      "summary": "Poster runs a landscaping company and keeps forgetting to call leads back.",
      "whyRelevant": "Explicitly asking for a follow-up reminder tool.",
      "postedAt": "2026-08-30",
      "relevanceScore": 0.92,
      "source": "reddit"
    }
  ],
  "saved": { "productId": "...", "count": 3, "searchDate": "..." },
  "meta": { "model": "sonar-pro", "searchedForums": ["reddit"], "searchedDomains": ["reddit.com"], "from": "2026-08-28", "to": "2026-09-04", "usage": { }, "rawResultCount": 8 }
}
```

Every search is stored under its product; each thread's `id` is the stored row's id. Create the product first with `POST /api/products`.

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

### `PATCH /api/products/:id`

Edits a product in place. The id never changes, and stored search results stay attached. Send the full product, the same three fields as on create; `website` may be omitted to clear it.

```bash
curl -s -X PATCH https://helpyoufindthat-backend.onrender.com/api/products/$PRODUCT_ID \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"FollowUp","website":"followup.app","description":"Nags small-business owners until they call their leads back"}'
```

Returns `200` with the updated product. Someone else's product returns 404. Changing the description is the intended way to steer later searches, since the search reads it from the product each time.

### `POST /api/products/describe`

Generates a product description from a website, for pre-filling the create or edit form. Nothing is saved. It costs one Perplexity call and counts against the search rate limit.

```bash
curl -s https://helpyoufindthat-backend.onrender.com/api/products/describe \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"website":"followup.app"}'
```

Returns `{ website, name, description, problem, audience, confidence, source, warnings, meta }`. The description says what the product does, who it is for, and the problem it solves, in plain language; `problem` is that problem in a customer's words.

**How the site is read.** The server reads the page itself first, then gives its title, meta description, headings, and visible text to the model. Search is only a fallback, because Perplexity's search knows only pages a search engine has indexed, and new product sites often are not. `source` says which path was used (`page` or `search`).

`warnings` explains a thin result in plain words. The common ones:

- **The page builds its content in the browser.** Single-page apps serve an empty shell, so only the title and meta description are readable. The description stays short and `confidence` is capped at 0.5. Server-side rendering or prerendering fixes this.
- **The page asks search engines not to index it.** A robots `noindex` tag hides the site from every search-based tool. It does not stop the direct read.
- **The site could not be read directly.** The domain did not resolve, the site errored or timed out, or the address was not a web page. The search fallback is then used, and the model is told not to guess from the domain name.

**Safety.** The reader refuses private, loopback, link-local (including the cloud metadata address), and reserved addresses, checked at connection time on every redirect hop; only `http`/`https` on ports 80 and 443; no embedded credentials; at most 3 redirects, 8 seconds, and 1.5 MB. A refused address returns `400` without calling Perplexity.

### `POST /api/products/:id/reply`

Composes the product's **general reply**: one short, reusable post the user edits before pitching on a thread. It is stored on the product as `generalReply` and returned by every product endpoint. Calling it again replaces it. Costs one Perplexity call and counts against the search rate limit.

```bash
curl -s -X POST https://helpyoufindthat-backend.onrender.com/api/products/$PRODUCT_ID/reply -H "Authorization: Bearer $TOKEN"
```

Returns `{ product, notes, meta }`, where `notes` is one sentence on what to change per thread. The reply is written to sound like a person on a forum rather than a company: first person, contractions, plain words, leading with the problem rather than the pitch, disclosing that you make the product, 50 to 90 words, no links.

`generalReply` is also accepted (optionally) by `POST /api/products` and `PATCH /api/products/:id`, so users can edit or clear it by hand. Omitting it on a PATCH leaves the stored reply untouched.

### `DELETE /api/products/:id/results/:resultId` and `DELETE /api/products/:id/results`

Delete one lead, or several at once with `{ "ids": ["...", "..."] }` in the body (or `?ids=a,b,c`). Up to 1000 ids per call. Only leads under your own product can be deleted; the bulk response lists `ids` that were deleted and `notFound` for the rest.

```bash
curl -s -X DELETE "https://helpyoufindthat-backend.onrender.com/api/products/$PRODUCT_ID/results" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"ids":["<result id>","<result id>"]}'
```

Note that a deleted lead can come back if a later search finds the same thread again, since searches store whatever they find.

### `GET /api/products/:id/results`

Stored search results for one of your products, latest search first, then by relevance score.

| Query parameter | Default | Notes |
|---|---|---|
| `limit` | 50 | max 1000 |
| `offset` | 0 | for paging |
| `source` | | filter to one forum id, e.g. `reddit` |
| `minScore` | | only results with `relevanceScore` at or above this (0 to 1) |

```bash
curl -s "https://helpyoufindthat-backend.onrender.com/api/products/$PRODUCT_ID/results?limit=100&source=reddit" -H "Authorization: Bearer $TOKEN"
```

Returns `{ productId, results: [ { id, productId, source, link, title, summary, whyRelevant, postedAt, relevanceScore, searchDate, createdAt } ], count, total, limit, offset }`. `total` is the number of matching rows regardless of paging.

**How storage works.** A thread is stored once per product, keyed on the link. If a later search returns the same thread again, its row is updated in place: `searchDate` moves to the latest search and the score, title, and summary are refreshed. Nothing is ever duplicated, and no result is excluded from a search because it was seen before. The search itself is stateless; to get different threads, change the product description.

The backend talks to Supabase's REST endpoint with the caller's own token, so no privileged database key is stored on the server. This needs `SUPABASE_ANON_KEY` (the publishable key) in the environment.

## How search works

Each request makes one Perplexity chat completion per requested forum, all at the same time, and ranks the threads from all of them together by score. A single call over several sites lets one site take nearly every retrieved source, so the other sites' best threads are never seen. Searching all six forums therefore costs six Perplexity calls, and takes about as long as the slowest one. Each call has:

- `search_domain_filter` restricted to that forum's domains
- `web_search_options.search_context_size` from `PERPLEXITY_SEARCH_CONTEXT` (default `medium`; `high` gathers more sources per call, at a higher cost)
- `search_after_date_filter` and `search_before_date_filter` set from the requested range (Perplexity does not allow combining these with `search_recency_filter`)
- a JSON-schema `response_format` asking for ranked threads with a relevance score

The prompt is aimed at demand, not supply: it asks for threads where users are looking for a recommendation, tool, service, alternative, or advice for a problem the product solves, and gives the product description as the thing to match. Launches, "Show HN" and "I built" posts, reviews, comparisons, and tutorials are never included, at any score. The model labels every thread's `intent` as `seeking`, `offering`, or `discussion`, and the server drops `offering` threads. General discussion and loose fits are kept with a relevance score of 0.3 or lower, so a search returns the number of threads requested whenever the search results contain that many; use `minScore` on the results endpoint to hide them.

**Every thread must come from Perplexity's own sources.** A thread is kept only if its link matches one of the search results or citations Perplexity returned for that call. Links are compared by post rather than exact text, so the same X, Reddit, or Hacker News post written two ways still matches. This rejects links the model invents, which it does when a search finds too little and the prompt asks for a full count; such a search now returns fewer threads rather than fake ones. If one forum's call fails, the others still return, and the response's `meta.failedForums` lists the failure.

Results are then filtered to URLs that are on one of the requested forums and look like a thread there (not an index or profile page), tagged with that forum as `source`, deduplicated, sorted by relevance, and cut to `threads`. Each thread carries `asksFor`, a few words on what the author wants, and the response's `meta.problem` shows the problem statement the model searched for, which is a quick way to check whether the product description is being understood.

The `relevanceScore` is the model's own 0 to 1 judgement of how strongly the author is seeking something like the product: 1 means explicitly asking for a tool that does what the product does, around 0.5 means describing the problem and wanting advice. It's a useful sort key, not a calibrated probability, and Perplexity's search layer exposes no score of its own. If the model returns unusable JSON the raw `search_results` are used as a fallback.

## Search log

Every search that reaches Perplexity writes one row to the `search_requests` table, whether it succeeds or fails. Requests rejected before that point, such as an unknown product or invalid input, are not logged.

Each row records:

- **The request:** product, user, forums, requested thread count, and date range.
- **What was sent:** the exact prompt, and the request settings (model, temperature, domain and date filters, search context size).
- **What came back:** how many sources Perplexity's search returned and their links, the citation links, a breakdown of each forum's call, how many threads the model proposed, how many were returned, and whether the raw-search fallback was used.
- **What was discarded, and why:** every proposed thread the server dropped, with a reason of `invalid_url`, `not_in_sources`, `not_on_requested_forum`, `not_a_thread`, `duplicate`, `offering`, or `over_limit`.
- **Everything else:** the model's problem statement, token usage, duration, and for failures the error and its HTTP status.

Rows are readable only by the user who owns them, and deleting a product or user deletes its rows. A scheduled database job (`pg_cron`, job `purge-search-requests-older-than-30-days`) deletes rows older than **30 days**, every Sunday at 03:17 UTC, so a row can remain for up to about 37 days. Writing the log never fails a search; if the write errors, it is printed to the server log instead.

To see why a search came back short, in the Supabase SQL editor:

```sql
select created_at, forums, threads_requested, raw_result_count, model_thread_count, returned_count, dropped
from search_requests
where product_id = '<product id>'
order by created_at desc
limit 5;
```

## Adding a forum

1. Create `src/forums/<name>.js` exporting `{ id, name, aliases, domains, isThreadUrl }`. See `src/forums/reddit.js`.
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
