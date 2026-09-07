import { PerplexityError } from '../errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = [
  'You find potential customers: people posting in public forums who have a problem and are asking for help, a tool, or a recommendation.',
  'You are looking for demand, not supply. A thread only counts if its author is seeking a solution.',
  'Threads that present, promote, launch, review, compare, or explain solutions are not leads and must be left out, even when they are about the exact product category.',
  'You only report real threads whose URLs appear in your search results. Never invent, guess, or alter URLs.',
  'If you find nothing that qualifies, return an empty list rather than padding it with weaker matches.',
].join(' ');

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    problem: {
      type: 'string',
      description: 'One sentence: the problem a person would have that this product solves, in the words such a person would use',
    },
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title of the thread or opening post' },
          url: { type: 'string', description: 'Exact URL of the thread, copied from search results' },
          intent: {
            type: 'string',
            enum: ['seeking', 'offering', 'discussion'],
            description: 'seeking = the author is asking for help, a tool, or a recommendation; offering = the author presents, promotes, reviews, or explains a solution; discussion = neither',
          },
          asks_for: { type: 'string', description: 'What the author is asking for, in a few words; empty if intent is not seeking' },
          summary: { type: 'string', description: 'One or two sentences describing the situation the author describes' },
          why_relevant: { type: 'string', description: 'Why this person is a potential customer for the described product' },
          posted_at: { type: 'string', description: 'When it was posted, as ISO 8601 date if known, otherwise empty string' },
          relevance_score: {
            type: 'number',
            description: 'How strongly the author is looking for something like this product, 0 to 1. 1 = explicitly asking for a tool or service that does what the product does; 0.5 = describes the problem and wants advice; below 0.3 = tangential',
          },
        },
        required: ['title', 'url', 'intent', 'asks_for', 'summary', 'why_relevant', 'posted_at', 'relevance_score'],
      },
    },
  },
  required: ['problem', 'threads'],
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
    ? 'Rank by how strongly the author is seeking something like this product.'
    : 'Rank by how strongly the author is seeking something like this product, across all sites together; do not favour one site over another.';
  return [
    'We sell this product:',
    '"""',
    productDescription,
    '"""',
    '',
    'First, state the problem a potential customer would have, in the words they would use when asking for help (the "problem" field).',
    `Then find up to ${threads} ${where} posted between ${isoDay(from)} and ${isoDay(to)} (inclusive) written by people who HAVE that problem and are ASKING for a solution: a recommendation, a tool, a service, an alternative, or advice on how to handle it.`,
    '',
    'Search the way those people write, for example: "looking for a tool that", "any recommendations for", "how do you all handle", "is there an app that", "struggling with", "what do you use for", "alternative to".',
    '',
    'Include only threads where the author is seeking. Exclude:',
    '- product launches, announcements, "I built", "Show HN", "check out my", or anything promoting a solution',
    '- reviews, comparisons, "best tools for" lists, tutorials, how-to guides, news, and opinion pieces',
    '- posts where the author already has a solution and is sharing or explaining it',
    '- general discussion of the topic with no request in it',
    'Threads like these are still "offering" or "discussion" even if the topic matches the product exactly.',
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
export const problemStatementFrom = (data) => {
  const parsed = parseContentJson(data?.choices?.[0]?.message?.content);
  return typeof parsed?.problem === 'string' && parsed.problem.trim() ? parsed.problem.trim() : null;
};

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

    // The model labels each thread's intent; anything that isn't someone seeking a solution is not a lead.
    if (typeof item.intent === 'string' && item.intent !== 'seeking') continue;

    const fromSearch = byUrl.get(key);
    results.push({
      title: String(item.title ?? fromSearch?.title ?? '').trim(),
      url: url.href,
      asksFor: String(item.asks_for ?? '').trim() || null,
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
      problem: problemStatementFrom(data),
      searchedForums: forums.map((f) => f.id),
      searchedDomains: domains,
      from: isoDay(from),
      to: isoDay(to),
      usage: data.usage ?? null,
      rawResultCount: Array.isArray(data.search_results) ? data.search_results.length : 0,
    },
  };
}
