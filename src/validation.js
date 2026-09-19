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
 * The range may not exceed config.limits.maxDays (three months) or end in the future.
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

/** A required boolean body field. Accepts JSON true/false and the strings "true"/"false". */
export function parseBoolean(value, name) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new HttpError(400, `"${name}" must be true or false`, { field: name, received: value });
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

  const websiteRaw = firstDefined(source, ['website', 'productWebsite', 'product_website', 'url']);
  const website = websiteRaw === undefined ? null : parseWebsite(websiteRaw);

  // Optional, and left untouched on update when absent, so editing a product
  // does not discard a composed reply.
  const replyRaw = source.generalReply ?? source.general_reply;
  let generalReply;
  if (replyRaw !== undefined) {
    if (replyRaw === null || replyRaw === '') {
      generalReply = null;
    } else if (typeof replyRaw !== 'string') {
      throw new HttpError(400, '"generalReply" must be a string', { field: 'generalReply' });
    } else if (replyRaw.length > 4000) {
      throw new HttpError(400, '"generalReply" must be at most 4000 characters', { field: 'generalReply', max: 4000 });
    } else {
      generalReply = replyRaw.trim();
    }
  }

  return { name, website, description, generalReply };
}

/** Normalises a website to a full http(s) URL string, or throws a 400. */
export function parseWebsite(value, name = 'website') {
  if (typeof value !== 'string') throw new HttpError(400, `"${name}" must be a string`, { field: name });
  let website = value.trim();
  if (website.length === 0) throw new HttpError(400, `"${name}" is required`, { field: name });
  if (website.length > 2048) throw new HttpError(400, `"${name}" must be at most 2048 characters`, { field: name });
  if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
  let parsed;
  try {
    parsed = new URL(website);
  } catch {
    throw new HttpError(400, `"${name}" must be a valid URL`, { field: name, received: value });
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes('.')) {
    throw new HttpError(400, `"${name}" must be a valid URL`, { field: name, received: value });
  }
  return parsed.href;
}

/**
 * A list of UUIDs from a JSON array, a comma-separated string, or a single id.
 * De-duplicated, lowercased, capped at `max`.
 */
export function parseUuidList(input, { name = 'ids', max = 1000 } = {}) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : input === undefined || input === null ? [] : [input];
  const ids = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item === 'string' && item.trim() === '') continue;
    const id = parseUuid(typeof item === 'string' ? item.trim() : item, name);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) throw new HttpError(400, `"${name}" must contain at least one id`, { field: name });
  if (ids.length > max) throw new HttpError(400, `"${name}" may contain at most ${max} ids`, { field: name, max, received: ids.length });
  return ids;
}

/**
 * Query parameters for listing stored results:
 *   limit (default 50, max 1000), offset (default 0), source (forum id), minScore (0..1)
 */
export function parseResultsQuery(source, { defaultLimit = 50, maxLimit = 1000 } = {}) {
  const limit = toPositiveInt(firstDefined(source, ['limit', 'pageSize', 'page_size']), { name: 'limit', fallback: defaultLimit, max: maxLimit });

  const offsetRaw = firstDefined(source, ['offset', 'skip']);
  let offset = 0;
  if (offsetRaw !== undefined) {
    const n = typeof offsetRaw === 'number' ? offsetRaw : Number(String(offsetRaw).trim());
    if (!Number.isInteger(n) || n < 0) throw new HttpError(400, '"offset" must be a non-negative integer', { field: 'offset', received: offsetRaw });
    offset = n;
  }

  let sourceId;
  const sourceRaw = firstDefined(source, ['source', 'forum', 'sourceSite', 'source_site']);
  if (sourceRaw !== undefined) {
    const forum = typeof sourceRaw === 'string' ? getForum(sourceRaw) : null;
    if (!forum) throw new HttpError(400, `Unsupported source "${sourceRaw}"`, { field: 'source', supported: listForums().map((f) => f.id) });
    sourceId = forum.id;
  }

  let minScore;
  const minRaw = firstDefined(source, ['minScore', 'min_score']);
  if (minRaw !== undefined) {
    const n = typeof minRaw === 'number' ? minRaw : Number(String(minRaw).trim());
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, '"minScore" must be a number between 0 and 1', { field: 'minScore', received: minRaw });
    minScore = n;
  }

  return { limit, offset, source: sourceId, minScore };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A plausible email address, trimmed, or a 400. */
export function parseEmail(value, name = 'email') {
  if (typeof value !== 'string') throw new HttpError(400, `"${name}" must be a string`, { field: name });
  const email = value.trim();
  if (email.length === 0 || email.length > 320 || !EMAIL_RE.test(email)) {
    throw new HttpError(400, `"${name}" must be an email address`, { field: name, received: value });
  }
  return email;
}

const parseScore = (value, { name, fallback }) => {
  if (value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, `"${name}" must be a number between 0 and 1`, { field: name, received: value });
  return n;
};

/**
 * Validates a request to schedule a daily search. Returns
 * { forums, threads, minScore, startDate, endDate, email }, where the dates are UTC days
 * and email is undefined when the caller did not supply one.
 *
 * Accepted parameter spellings:
 *   forum | forums | forumName | forum_name     (id, list of ids, comma-separated ids, or "all")
 *   threads | maxThreads | max_threads          (per run; default 10, max 50)
 *   endDate | end_date | to | until | runUntil  (YYYY-MM-DD, inclusive; today or later, at most maxDays out)
 *   minScore | min_score                        (0 to 1; default 0.8)
 *   email                                       (defaults to the signed-in user's address)
 */
export function parseJobRequest(source, config, { now = new Date() } = {}) {
  if (!source || typeof source !== 'object') throw new HttpError(400, 'Request body must be a JSON object');

  const forums = parseForums(firstDefined(source, ['forum', 'forums', 'forumName', 'forum_name']));
  const threads = toPositiveInt(firstDefined(source, ['threads', 'maxThreads', 'max_threads']), {
    name: 'threads',
    fallback: config.defaults.threads,
    max: config.limits.maxThreads,
  });
  const minScore = parseScore(firstDefined(source, ['minScore', 'min_score']), { name: 'minScore', fallback: config.jobs.defaultMinScore });

  const endRaw = firstDefined(source, ['endDate', 'end_date', 'to', 'until', 'runUntil', 'run_until']);
  if (endRaw === undefined) throw new HttpError(400, '"endDate" is required: the last day the job should run, like 2026-10-01', { field: 'endDate' });
  const endDate = parseDate(endRaw, 'endDate');
  const startDate = utcDay(now);
  if (endDate < startDate) throw new HttpError(400, '"endDate" cannot be in the past', { field: 'endDate', received: isoDay(endDate), today: isoDay(startDate) });
  const spanDays = Math.round((endDate - startDate) / DAY_MS);
  if (spanDays > config.limits.maxDays) {
    throw new HttpError(400, `"endDate" may be at most ${config.limits.maxDays} days from today`, { field: 'endDate', received: isoDay(endDate), spanDays, maxDays: config.limits.maxDays });
  }

  const emailRaw = firstDefined(source, ['email', 'notifyEmail', 'notify_email']);
  const email = emailRaw === undefined ? undefined : parseEmail(emailRaw);

  return { forums, threads, minScore, startDate, endDate, email };
}

const JOB_STATUSES = ['active', 'completed', 'cancelled'];

/** Query parameters for listing jobs: productId and status, both optional. */
export function parseJobsQuery(source) {
  const productRaw = firstDefined(source, ['productId', 'product_id']);
  const productId = productRaw === undefined ? undefined : parseUuid(productRaw, 'productId');
  const statusRaw = firstDefined(source, ['status']);
  let status;
  if (statusRaw !== undefined) {
    status = String(statusRaw).trim().toLowerCase();
    if (!JOB_STATUSES.includes(status)) throw new HttpError(400, `"status" must be one of ${JOB_STATUSES.join(', ')}`, { field: 'status', received: statusRaw });
  }
  return { productId, status };
}

/** Query parameters for listing a job's runs: limit (default 30, max 365) and offset. */
export function parseRunsQuery(source) {
  const { limit, offset } = parseResultsQuery({ limit: firstDefined(source, ['limit']), offset: firstDefined(source, ['offset']) }, { defaultLimit: 30, maxLimit: 365 });
  return { limit, offset };
}
