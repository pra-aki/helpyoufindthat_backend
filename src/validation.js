import { HttpError } from './errors.js';
import { forums as allForums, getForum, listForums } from './forums/index.js';

const firstDefined = (source, keys) => {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return undefined;
};

const toPositiveInt = (value, { name, fallback, max }) => {
  if (value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1) {
    throw new HttpError(400, `"${name}" must be a positive integer`, { field: name, received: value });
  }
  if (n > max) {
    throw new HttpError(400, `"${name}" must be at most ${max}`, { field: name, received: value, max });
  }
  return n;
};

/**
 * Accepts a forum id, a list of ids, a comma-separated string, or "all".
 * Returns a de-duplicated array of forum registry entries in request order.
 */
export function parseForums(input) {
  const supported = listForums().map((f) => f.id);
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : input === undefined ? [] : [input];
  const names = raw.map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== '' && v !== undefined && v !== null);

  if (names.length === 0) {
    throw new HttpError(400, '"forum" is required: a forum id, a list of ids, or "all"', { field: 'forum', supported: [...supported, 'all'] });
  }
  if (names.some((n) => typeof n !== 'string')) {
    throw new HttpError(400, '"forum" must be a string or a list of strings', { field: 'forum', supported: [...supported, 'all'] });
  }
  if (names.some((n) => n.toLowerCase() === 'all')) {
    return [...allForums];
  }
  const seen = new Set();
  const resolved = [];
  for (const name of names) {
    const forum = getForum(name);
    if (!forum) {
      throw new HttpError(400, `Unsupported forum "${name}"`, { field: 'forum', received: name, supported: [...supported, 'all'] });
    }
    if (!seen.has(forum.id)) {
      seen.add(forum.id);
      resolved.push(forum);
    }
  }
  return resolved;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
export const isoDay = (date) => date.toISOString().slice(0, 10);

const parseDate = (value, name) => {
  if (value === undefined) return undefined;
  const str = String(value).trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(str) ? new Date(`${str}T00:00:00Z`) : new Date(str);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, `"${name}" must be a date like 2026-09-04`, { field: name, received: value });
  }
  return utcDay(parsed);
};

/**
 * Resolves the search window to whole UTC days, inclusive on both ends.
 *
 *   from + to      explicit range
 *   from only      from .. today
 *   to only        (to - days) .. to
 *   neither        (today - days) .. today, days defaulting to 1
 *
 * The range may not exceed config.limits.maxDays (one year) or end in the future.
 */
export function parseDateRange(source, config, { now = new Date() } = {}) {
  const today = utcDay(now);
  const maxDays = config.limits.maxDays;

  const daysInput = firstDefined(source, ['days', 'y']);
  const days = toPositiveInt(daysInput, { name: 'days', fallback: config.defaults.days, max: maxDays });
  let from = parseDate(firstDefined(source, ['from', 'startDate', 'start_date', 'dateFrom', 'date_from']), 'from');
  let to = parseDate(firstDefined(source, ['to', 'endDate', 'end_date', 'dateTo', 'date_to']), 'to');

  if (to === undefined) to = today;
  if (from === undefined) from = new Date(to.getTime() - days * DAY_MS);

  if (to > today) throw new HttpError(400, '"to" cannot be in the future', { field: 'to', received: isoDay(to), today: isoDay(today) });
  if (from > to) throw new HttpError(400, '"from" must be on or before "to"', { from: isoDay(from), to: isoDay(to) });
  const spanDays = Math.round((to - from) / DAY_MS);
  if (spanDays > maxDays) {
    throw new HttpError(400, `Date range may not exceed ${maxDays} days`, { from: isoDay(from), to: isoDay(to), spanDays, maxDays });
  }
  return { from, to, days: spanDays };
}

/**
 * Accepts the request body (POST) or query string (GET) and returns
 * { productDescription, forums, threads, from, to, days }.
 *
 * Accepted parameter spellings:
 *   productDescription | product_description | description
 *   forum | forums | forumName | forum_name   (id, list of ids, comma-separated ids, or "all")
 *   threads | x | maxThreads | max_threads
 *   from | startDate | start_date, to | endDate | end_date   (YYYY-MM-DD, inclusive)
 *   days | y                                                (shortcut: the last N days)
 */
export function parseSearchRequest(source, config, { now = new Date() } = {}) {
  if (!source || typeof source !== 'object') {
    throw new HttpError(400, 'Request must contain parameters');
  }

  const description = firstDefined(source, ['productDescription', 'product_description', 'description']);
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new HttpError(400, '"productDescription" is required and must be a non-empty string', {
      field: 'productDescription',
    });
  }
  if (description.length > config.limits.maxDescriptionLength) {
    throw new HttpError(400, `"productDescription" must be at most ${config.limits.maxDescriptionLength} characters`, {
      field: 'productDescription',
      max: config.limits.maxDescriptionLength,
    });
  }

  const forums = parseForums(firstDefined(source, ['forum', 'forums', 'forumName', 'forum_name']));

  const threads = toPositiveInt(firstDefined(source, ['threads', 'x', 'maxThreads', 'max_threads']), {
    name: 'threads',
    fallback: config.defaults.threads,
    max: config.limits.maxThreads,
  });
  const { from, to, days } = parseDateRange(source, config, { now });

  return { productDescription: description.trim(), forums, threads, from, to, days };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuid(value, name = 'id') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new HttpError(400, `"${name}" must be a UUID`, { field: name, received: value });
  }
  return value.toLowerCase();
}

const requiredText = (value, { name, max }) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `"${name}" is required and must be a non-empty string`, { field: name });
  }
  if (value.length > max) {
    throw new HttpError(400, `"${name}" must be at most ${max} characters`, { field: name, max });
  }
  return value.trim();
};

/**
 * Validates a product payload. Accepts camelCase or snake_case keys.
 * Returns { name, website, description }.
 */
export function parseProductRequest(source) {
  if (!source || typeof source !== 'object') {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  const name = requiredText(firstDefined(source, ['name', 'productName', 'product_name']), { name: 'name', max: 200 });
  const description = requiredText(firstDefined(source, ['description', 'productDescription', 'product_description']), {
    name: 'description',
    max: 2000,
  });

  let website = firstDefined(source, ['website', 'productWebsite', 'product_website', 'url']);
  if (website !== undefined) {
    if (typeof website !== 'string') throw new HttpError(400, '"website" must be a string', { field: 'website' });
    website = website.trim();
    if (website.length > 2048) throw new HttpError(400, '"website" must be at most 2048 characters', { field: 'website' });
    if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
    let parsed;
    try {
      parsed = new URL(website);
    } catch {
      throw new HttpError(400, '"website" must be a valid URL', { field: 'website', received: source.website });
    }
    if (!parsed.hostname.includes('.')) throw new HttpError(400, '"website" must be a valid URL', { field: 'website', received: source.website });
    website = parsed.href;
  } else {
    website = null;
  }

  return { name, website, description };
}
