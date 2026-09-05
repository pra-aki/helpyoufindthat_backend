import { PerplexityError } from '../errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = [
  'You are a research assistant that finds public online discussions where people are actively looking for a solution, tool, or product.',
  'You only report real threads whose URLs appear in your search results. Never invent, guess, or alter URLs.',
  'If you find nothing relevant, return an empty list.',
].join(' ');

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title of the thread or opening post' },
          url: { type: 'string', description: 'Exact URL of the thread, copied from search results' },
          summary: { type: 'string', description: 'One or two sentences describing what the poster is asking for' },
          why_relevant: { type: 'string', description: 'Why this thread indicates demand for the described product' },
          posted_at: { type: 'string', description: 'When it was posted, as ISO 8601 date if known, otherwise empty string' },
          relevance_score: { type: 'number', description: 'Relevance from 0 (weak) to 1 (strong buying/searching intent)' },
        },
        required: ['title', 'url', 'summary', 'why_relevant', 'posted_at', 'relevance_score'],
      },
    },
  },
  required: ['threads'],
};

/** Perplexity date filters use MM/DD/YYYY. */
export const formatPerplexityDate = (date) => {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
};

const joinNames = (names) => (names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

const isoDay = (date) => date.toISOString().slice(0, 10);

export function buildUserPrompt({ productDescription, forums, threads, from, to }) {
  const single = forums.length === 1;
  const where = single ? `public ${forums[0].name} threads` : `public threads on ${joinNames(forums.map((f) => f.name))}`;
  const hints = single ? [forums[0].threadHint] : ['What counts as a thread on each site:', ...forums.map((f) => `- ${f.name}: ${f.threadHint}`)];
  const ranking = single
    ? 'Rank by relevance, with the strongest buying or searching intent first.'
    : 'Rank by relevance across all sites together, with the strongest buying or searching intent first; do not favour one site over another.';
  return [
    'Product description:',
    '"""',
    productDescription,
    '"""',
    '',
    `Find up to ${threads} ${where} posted between ${isoDay(from)} and ${isoDay(to)} (inclusive) where the poster is looking for a solution like the product described above.`,
    'Strong signals: asking for recommendations or alternatives, asking how to solve the underlying problem, "is there a tool that ...", or frustration that no good solution exists.',
    '',
    ...hints,
    '',
    `${ranking} Only include threads whose URL appeared in your search results. Return JSON matching the schema.`,
  ].join('\n');
}

const hostMatches = (hostname, domains) => domains.some((d) => hostname === d || hostname.endsWith(`.${d}`));

/** Which of the given forums a URL belongs to, or null. */
export const forumForUrl = (url, forums) => forums.find((f) => hostMatches(url.hostname, f.domains)) ?? null;

const dedupeKey = (url) => `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`.toLowerCase();

const clampScore = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
};

const parseContentJson = (content) => {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.unshift(fenced[1]);
  const braces = trimmed.match(/\{[\s\S]*\}/);
  if (braces) candidates.push(braces[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.threads)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
};

/**
 * Turns a Perplexity chat completion into a ranked, filtered list of threads
 * across the requested forums. Exported for testing.
 */
export function parseThreadsResponse(data, { forums, threads }) {
  const searchResults = Array.isArray(data?.search_results) ? data.search_results : [];
  const byUrl = new Map();
  for (const r of searchResults) {
    try {
      byUrl.set(dedupeKey(new URL(r.url)), r);
    } catch {
      // ignore malformed search result URLs
    }
  }

  const content = data?.choices?.[0]?.message?.content;
  const parsed = parseContentJson(content);

  // Prefer the model's ranked list; fall back to raw search results if it returned nothing usable.
  const candidates = parsed
    ? parsed.threads
    : searchResults.map((r) => ({
        title: r.title,
        url: r.url,
        summary: r.snippet ?? '',
        why_relevant: 'Returned by search for the product description',
        posted_at: r.date ?? '',
        relevance_score: 0.5,
      }));

  const seen = new Set();
  const results = [];
  for (const item of candidates) {
    let url;
    try {
      url = new URL(String(item?.url ?? ''));
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const forum = forumForUrl(url, forums);
    if (!forum) continue;
    if (typeof forum.isThreadUrl === 'function' && !forum.isThreadUrl(url)) continue;

    const key = dedupeKey(url);
    if (seen.has(key)) continue;
    seen.add(key);

    const fromSearch = byUrl.get(key);
    results.push({
      title: String(item.title ?? fromSearch?.title ?? '').trim(),
      url: url.href,
      summary: String(item.summary ?? '').trim(),
      whyRelevant: String(item.why_relevant ?? '').trim(),
      postedAt: String(item.posted_at || fromSearch?.date || '').trim() || null,
      relevanceScore: clampScore(item.relevance_score),
      source: forum.id,
    });
  }

  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return results.slice(0, threads);
}

/**
 * Searches one or more forums through Perplexity's Sonar API in a single call.
 *
 * @param {object} params
 * @param {string} params.productDescription
 * @param {object[]} params.forums   entries from the forum registry
 * @param {number} params.threads    max results to return in total
 * @param {Date} params.from         first day to include (UTC)
 * @param {Date} params.to           last day to include (UTC)
 * @param {object} params.config     app config (see src/config.js)
 * @param {Function} [params.fetchImpl]  injectable fetch for tests
 * @param {Date} [params.now]            injectable clock for tests
 */
export async function searchThreads({ productDescription, forums, threads, from, to, config, fetchImpl = fetch }) {
  const { apiKey, baseUrl, model, timeoutMs, searchContextSize } = config.perplexity;
  if (!apiKey) {
    throw new PerplexityError('Server is missing PERPLEXITY_API_KEY', { status: 500 });
  }

  const domains = [...new Set(forums.flatMap((f) => f.domains))];
  const requestBody = {
    model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ productDescription, forums, threads, from, to }) },
    ],
    search_domain_filter: domains,
    // Perplexity rejects search_recency_filter combined with date filters, so only the exact dates are sent.
    // The "before" filter is exclusive, so the day after "to" makes the range inclusive.
    search_after_date_filter: formatPerplexityDate(from),
    search_before_date_filter: formatPerplexityDate(new Date(to.getTime() + DAY_MS)),
    web_search_options: { search_context_size: searchContextSize },
    return_related_questions: false,
    response_format: { type: 'json_schema', json_schema: { schema: RESPONSE_SCHEMA } },
  };

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    throw new PerplexityError(timedOut ? `Perplexity request timed out after ${timeoutMs}ms` : 'Could not reach Perplexity', {
      status: timedOut ? 504 : 502,
      cause,
    });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => undefined);
    throw new PerplexityError(`Perplexity request failed with HTTP ${response.status}`, {
      status: response.status === 429 ? 429 : 502,
      details: detail ? detail.slice(0, 500) : undefined,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (cause) {
    throw new PerplexityError('Perplexity returned a non-JSON response', { cause });
  }

  return {
    threads: parseThreadsResponse(data, { forums, threads }),
    meta: {
      model: data.model ?? model,
      searchedForums: forums.map((f) => f.id),
      searchedDomains: domains,
      from: isoDay(from),
      to: isoDay(to),
      usage: data.usage ?? null,
      rawResultCount: Array.isArray(data.search_results) ? data.search_results.length : 0,
    },
  };
}
