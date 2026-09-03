import { HttpError } from './errors.js';
import { getForum, listForums } from './forums/index.js';

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
 * Accepts the request body (POST) or query string (GET) and returns
 * { productDescription, forum, threads, days }.
 *
 * Accepted parameter spellings:
 *   productDescription | product_description | description
 *   forum | forumName | forum_name
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

  const forumInput = firstDefined(source, ['forum', 'forumName', 'forum_name']);
  if (typeof forumInput !== 'string' || forumInput.trim().length === 0) {
    throw new HttpError(400, '"forum" is required', {
      field: 'forum',
      supported: listForums().map((f) => f.id),
    });
  }
  const forum = getForum(forumInput);
  if (!forum) {
    throw new HttpError(400, `Unsupported forum "${forumInput}"`, {
      field: 'forum',
      received: forumInput,
      supported: listForums().map((f) => f.id),
    });
  }

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

  return { productDescription: description.trim(), forum, threads, days };
}
