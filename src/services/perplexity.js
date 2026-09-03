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

/** Coarse bucket that Perplexity's search_recency_filter understands. */
export const recencyFilterFor = (days) => (days <= 1 ? 'day' : days <= 7 ? 'week' : days <= 31 ? 'month' : 'year');

export function buildUserPrompt({ productDescription, forum, threads, days, after }) {
  return [
    'Product description:',
    '"""',
    productDescription,
    '"""',
    '',
    `Find up to ${threads} public ${forum.name} threads posted within the last ${days} day${days === 1 ? '' : 's'} (on or after ${after.toISOString().slice(0, 10)}) where the poster is looking for a solution like the product described above.`,
    'Strong signals: asking for recommendations or alternatives, asking how to solve the underlying problem, "is there a tool that ...", or frustration that no good solution exists.',
    '',
    forum.threadHint,
    '',
    'Rank by relevance, with the strongest buying or searching intent first. Only include threads whose URL appeared in your search results. Return JSON matching the schema.',
  ].join('\n');
}

const hostMatches = (hostname, domains) =>
  domains.some((d) => hostname === d || hostname.endsWith(`.${d}`));

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
 * Turns a Perplexity chat completion into a ranked, filtered list of threads.
 * Exported for testing.
 */
export function parseThreadsResponse(data, { forum, threads }) {
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
    if (!hostMatches(url.hostname, forum.domains)) continue;
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
 * Searches one forum through Perplexity's Sonar API.
 *
 * @param {object} params
 * @param {string} params.productDescription
 * @param {object} params.forum      entry from the forum registry
 * @param {number} params.threads    max results to return
 * @param {number} params.days       how far back to look
 * @param {object} params.config     app config (see src/config.js)
 * @param {Function} [params.fetchImpl]  injectable fetch for tests
 * @param {Date} [params.now]            injectable clock for tests
 */
export async function searchThreads({ productDescription, forum, threads, days, config, fetchImpl = fetch, now = new Date() }) {
  const { apiKey, baseUrl, model, timeoutMs } = config.perplexity;
  if (!apiKey) {
    throw new PerplexityError('Server is missing PERPLEXITY_API_KEY', { status: 500 });
  }

  const after = new Date(now.getTime() - days * DAY_MS);
  const requestBody = {
    model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ productDescription, forum, threads, days, after }) },
    ],
    search_domain_filter: forum.domains,
    search_recency_filter: recencyFilterFor(days),
    search_after_date_filter: formatPerplexityDate(after),
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
    threads: parseThreadsResponse(data, { forum, threads }),
    meta: {
      model: data.model ?? model,
      searchedDomains: forum.domains,
      after: after.toISOString(),
      usage: data.usage ?? null,
      rawResultCount: Array.isArray(data.search_results) ? data.search_results.length : 0,
    },
  };
}
