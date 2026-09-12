import { HttpError, PerplexityError } from '../errors.js';
import { fetchPage, extractPageContent } from './pageFetch.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
            description: 'How strongly the author is looking for something like this product, 0 to 1. 1 = explicitly asking for a tool or service that does what the product does; 0.5 = describes the problem and wants advice; 0.3 or lower = general discussion of the topic or a loose fit, included to fill the requested count',
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
  const where = single ? forums[0].name : joinNames(forums.map((f) => f.name));
  const ranking = single
    ? 'Rank by how strongly the author is seeking something like this product.'
    : 'Rank by how strongly the author is seeking something like this product, across all sites together; do not favour one site over another.';
  return [
    `Search for ${threads} threads or discussions in user forums on ${where} posted between ${isoDay(from)} and ${isoDay(to)} (inclusive) where users are looking for a solution: a recommendation, a tool, a service, an alternative, or advice, for a problem that can be solved by our product:`,
    '',
    '"""',
    productDescription,
    '"""',
    '',
    'Never include posts that offer rather than ask:',
    '- product launches, announcements, "I built", "Show HN", "check out my", or anything promoting a solution',
    '- reviews, comparisons, "best tools for" lists, tutorials, how-to guides, news, and opinion pieces',
    '- posts where the author already has a solution and is sharing or explaining it',
    'Posts like these are "offering" even if the topic matches the product exactly, so leave them out at any score.',
    'A partial fit still counts. If the product would help with part of what the author is asking about, include the thread and score it accordingly.',
    `Return ${threads} threads. If fewer than ${threads} strongly match, fill the rest with the closest weaker matches, such as general discussion of the topic or a loose fit, and give those a relevance score of 0.3 or lower. Do not return fewer than ${threads} while real threads remain in your search results.`,
    '',
    `${ranking} Only include threads whose URL appeared in your search results, copied exactly; never invent, guess, or alter a URL.`,
    '',
    'Return JSON matching the schema.',
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

const parseContentJson = (content, { requireThreads = true } = {}) => {
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
      if (parsed && typeof parsed === 'object' && (!requireThreads || Array.isArray(parsed.threads))) return parsed;
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
    // Promotions are never leads. Everything else is kept and ranked by its score, so weak matches fill the count.
    if (item.intent === 'offering') continue;

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

/** Sends one chat completion to Perplexity and returns the parsed JSON body, mapping failures to HTTP errors. */
async function callPerplexity(requestBody, config, fetchImpl) {
  const { apiKey, baseUrl, timeoutMs } = config.perplexity;
  if (!apiKey) {
    throw new PerplexityError('Server is missing PERPLEXITY_API_KEY', { status: 500 });
  }

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

  try {
    return await response.json();
  } catch (cause) {
    throw new PerplexityError('Perplexity returned a non-JSON response', { cause });
  }
}

const DESCRIBE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'The product or company name as the site presents it' },
    description: {
      type: 'string',
      description: 'Two to four plain sentences: what the product does, who it is for, and the problem it solves for them. No marketing adjectives, no slogans.',
    },
    problem: { type: 'string', description: 'One sentence: the problem a customer would have, in the words they would use when asking for help' },
    audience: { type: 'string', description: 'Who the product is for, in a few words' },
    confidence: { type: 'number', description: '0 to 1: how well the available content supported this description' },
  },
  required: ['name', 'description', 'problem', 'audience', 'confidence'],
};

// Codes where retrying through search makes no sense: the address itself was refused.
const REFUSED_ADDRESS = new Set(['EBLOCKEDADDRESS', 'EPROTOCOL', 'EPORT', 'ECREDENTIALS']);

/**
 * Describes the product at a website, written the way the search prompt wants it.
 *
 * The page is read by this server first (with private and internal addresses
 * refused), because Perplexity's search only knows pages a search engine has
 * indexed, and new product sites often are not. Web search is the fallback when
 * the page cannot be read at all.
 *
 * @param {object} params
 * @param {string} params.website
 * @param {object} params.config
 * @param {Function} [params.fetchImpl]      fetch used for Perplexity
 * @param {Function} [params.fetchPageImpl]  page reader, injectable for tests
 */
export async function describeWebsite({ website, config, fetchImpl = fetch, fetchPageImpl = fetchPage }) {
  const { model, searchContextSize } = config.perplexity;
  const hostname = new URL(website).hostname.replace(/^www\./, '');

  let page = null;
  let readError = null;
  try {
    const fetched = await fetchPageImpl(website);
    page = { url: fetched.url, ...extractPageContent(fetched.html) };
  } catch (err) {
    if (REFUSED_ADDRESS.has(err?.code)) throw new HttpError(400, `Cannot read that website: ${err.message}`, { field: 'website', reason: err.code });
    readError = err?.message ?? 'could not read the page';
  }

  const hasText = Boolean(page && page.textLength >= 40);
  const hasMeta = Boolean(page && (page.title || page.description));
  const fromPage = hasText || hasMeta;
  const metadataOnly = fromPage && !hasText;

  const warnings = [];
  if (readError) warnings.push(`The site could not be read directly (${readError}), so this falls back to web search, which only finds pages search engines have indexed.`);
  if (page?.clientRendered) warnings.push('The page builds its content in the browser with JavaScript, so only its title and meta description could be read. Server-side rendering or prerendering would give a fuller description.');
  if (page?.noindex) warnings.push('The page asks search engines not to index it (a robots "noindex" tag), so search-based tools, including this one\'s fallback, cannot find it.');
  if (page && !fromPage) warnings.push('The page had no readable text, title, or description.');

  const source = fromPage
    ? [
        `Describe the product at ${website} using the content read from the page below.`,
        metadataOnly
          ? 'Only the page title and meta description were available. Keep the description short and close to what they say, and set confidence no higher than 0.5.'
          : 'You may use web search to add detail from other pages on the same site. If search finds nothing, rely entirely on the content below.',
        'Do not add anything the content does not support.',
        '',
        'Content read from the page:',
        '"""',
        ...[
          page.title && `Title: ${page.title}`,
          page.siteName && `Site name: ${page.siteName}`,
          page.description && `Meta description: ${page.description}`,
          page.headings.length && `Headings: ${page.headings.join(' | ')}`,
          hasText && `Page text: ${page.text}`,
        ].filter(Boolean),
        '"""',
      ]
    : [
        `Find and read the product website at ${website}, including its main pages such as home, product, pricing, and about.`,
        'If it does not appear in your search results, say plainly in the description that the site could not be found, and set confidence to 0. Do not guess what the product does from its name or domain.',
      ];

  const requestBody = {
    model,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: 'You describe a product factually for someone who has never seen it, using only the content you are given or find. You never guess what a product does from its name.',
      },
      {
        role: 'user',
        content: [
          ...source,
          '',
          'Write a description that will be used to find people who need this product. In plain language it must say:',
          '1. what the product does',
          '2. who it is for',
          '3. the problem it solves for them, and what that problem looks like day to day',
          'Two to four sentences, no marketing adjectives, no slogans, no claims the content does not make.',
          '',
          'Also give the product name, the audience in a few words, and the problem in the words a customer would use when asking for help. Return JSON matching the schema.',
        ].join('\n'),
      },
    ],
    search_domain_filter: [hostname],
    web_search_options: { search_context_size: searchContextSize },
    return_related_questions: false,
    response_format: { type: 'json_schema', json_schema: { schema: DESCRIBE_SCHEMA } },
  };

  const data = await callPerplexity(requestBody, config, fetchImpl);
  const parsed = parseContentJson(data?.choices?.[0]?.message?.content, { requireThreads: false });
  if (!parsed || typeof parsed.description !== 'string' || !parsed.description.trim()) {
    throw new PerplexityError('Perplexity did not return a usable description', { status: 502 });
  }

  const cleanText = (v, max) => String(v ?? '').trim().slice(0, max) || null;
  let confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
  if (metadataOnly) confidence = Math.min(confidence, 0.5);

  return {
    website,
    name: cleanText(parsed.name, 200),
    description: cleanText(parsed.description, 2000),
    problem: cleanText(parsed.problem, 500),
    audience: cleanText(parsed.audience, 200),
    confidence,
    source: fromPage ? 'page' : 'search',
    warnings,
    meta: {
      model: data.model ?? model,
      usage: data.usage ?? null,
      sources: Array.isArray(data.search_results) ? data.search_results.map((r) => r.url).filter(Boolean).slice(0, 10) : [],
      page: page
        ? { url: page.url, title: page.title, textLength: page.textLength, clientRendered: page.clientRendered, noindex: page.noindex }
        : null,
    },
  };
}

const GENERAL_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'The reply text itself, ready to paste and edit. No greeting, no sign-off, no links, no formatting.',
    },
    notes: {
      type: 'string',
      description: 'One sentence telling the person posting it what to change for a specific thread',
    },
  },
  required: ['reply', 'notes'],
};

/**
 * Composes a reusable reply for a product: the starting point a user edits
 * before posting it on a thread where someone is asking for this kind of thing.
 *
 * @param {object} params
 * @param {object} params.product   { name, description, website }
 * @param {object} params.config
 * @param {Function} [params.fetchImpl]
 */
export async function composeGeneralReply({ product, config, fetchImpl = fetch }) {
  const { model, searchContextSize } = config.perplexity;
  const domain = product.website ? [new URL(product.website).hostname.replace(/^www\./, '')] : undefined;

  const requestBody = {
    model,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content:
          'You write the way people actually write on forums: first person, plain, specific, a little informal. You are the person who built the product, replying to someone who has the problem it addresses. You never sound like marketing copy or customer support. You always disclose that you made it, and you never claim experience, results, or features you were not given.',
      },
      {
        role: 'user',
        content: [
          `Product name: ${product.name}`,
          product.website ? `Website: ${product.website}` : null,
          'What it does:',
          '"""',
          product.description,
          '"""',
          '',
          'Write one reply we can post on forum threads where someone is asking for something like this. A person will adapt it to each thread, so it has to read naturally on its own and be easy to edit.',
          '',
          'Write as the person who built it, replying to someone who has that problem. Plain spoken, first person, contractions, the way you would type on a forum rather than the way a company writes.',
          'Say what the product does about the problem, in one or two plain sentences, the way a user would say it. Mention once that you built it, so the promotion is disclosed.',
          product.website ? `Point them at it with the bare link, once: ${product.website}` : 'There is no link to give, so do not invent one.',
          'Do not open with sympathy or agreement. Do not claim to have had the problem yourself, to use the product yourself, or to have any experience you were not given.',
          '50 to 90 words. No greeting, no sign-off, no bullet points, no exclamation marks.',
          'Never write "Great question", "I totally understand", "I ran into the same", "Hope this helps", "Feel free to", "reach out", "solution", "leverage", "streamline", "seamless", "robust" or "game-changer".',
          'Claim nothing the description above does not support: no results, no pricing, no features it does not mention. Leave the specifics of any one thread out; the person posting will add those.',
          '',
          'Also give one sentence of notes on what to change per thread. Return JSON matching the schema.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    ...(domain ? { search_domain_filter: domain } : {}),
    web_search_options: { search_context_size: searchContextSize },
    return_related_questions: false,
    response_format: { type: 'json_schema', json_schema: { schema: GENERAL_REPLY_SCHEMA } },
  };

  const data = await callPerplexity(requestBody, config, fetchImpl);
  const parsed = parseContentJson(data?.choices?.[0]?.message?.content, { requireThreads: false });
  const reply = typeof parsed?.reply === 'string' ? parsed.reply.trim() : '';
  if (!reply) {
    throw new PerplexityError('Perplexity did not return a usable reply', { status: 502 });
  }
  return {
    reply: reply.slice(0, 4000),
    notes: String(parsed.notes ?? '').trim().slice(0, 500) || null,
    meta: { model: data.model ?? model, usage: data.usage ?? null },
  };
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
  const { model, searchContextSize } = config.perplexity;
  const domains = [...new Set(forums.flatMap((f) => f.domains))];
  const requestBody = {
    model,
    // Extraction and ranking need to be repeatable, so this stays low; the reply prompt, not the
    // sampling temperature, is what keeps the drafts from reading like a template.
    temperature: 0.1,
    messages: [
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

  const data = await callPerplexity(requestBody, config, fetchImpl);

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
