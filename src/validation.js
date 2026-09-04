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

/**
 * Accepts the request body (POST) or query string (GET) and returns
 * { productDescription, forums, threads, days }.
 *
 * Accepted parameter spellings:
 *   productDescription | product_description | description
 *   forum | forums | forumName | forum_name   (id, list of ids, comma-separated ids, or "all")
 *   threads | x | maxThreads | max_threads
 *   days | y
 */
export function parseSearchRequest(source, config) {
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
  const days = toPositiveInt(firstDefined(source, ['days', 'y']), {
    name: 'days',
    fallback: config.defaults.days,
    max: config.limits.maxDays,
  });

  return { productDescription: description.trim(), forums, threads, days };
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
