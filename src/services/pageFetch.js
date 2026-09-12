import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

/**
 * Reads a public web page on behalf of a user, refusing anything that points
 * inside our network: private, loopback, link-local (including the cloud
 * metadata address), and reserved ranges, checked on every redirect hop.
 */

export class FetchError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
  }
}

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96], ['100::', 64],
]) blocked.addSubnet(addr, prefix, 'ipv6');

/** True for any address we must not connect to, and for anything that is not an IP at all. */
export function isBlockedAddress(address) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) return blocked.check(address, 'ipv6');
  return true;
}

/**
 * DNS lookup that refuses hostnames resolving to a blocked address. Used as the
 * socket's lookup, so the address checked is the address connected to, which
 * closes the DNS-rebinding gap a check-then-fetch would leave open.
 */
export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const opts = { all: true };
  if (options?.family) opts.family = options.family;
  if (options?.hints) opts.hints = options.hints;
  dns.lookup(hostname, opts, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) {
      return callback(new FetchError('that address is not a public website', 'EBLOCKEDADDRESS'));
    }
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const STANDARD_PORTS = new Set(['', '80', '443']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const describeNetworkError = (err) => {
  switch (err?.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the domain does not resolve';
    case 'ECONNREFUSED':
      return 'the site refused the connection';
    case 'ECONNRESET':
      return 'the site closed the connection';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return "the site's HTTPS certificate is not valid";
    default:
      return 'could not connect to the site';
  }
};

function requestOnce(url, { lookup, deadline, maxBytes }) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FetchError('the site took too long to respond', 'ETIMEDOUT'));

    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'GET',
      lookup,
      headers: {
        'User-Agent': 'HelpYouFindThat-Describer/1.0 (reads a product page when its owner asks for a description)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new FetchError('the site took too long to respond', 'ETIMEDOUT'));
    }, remaining);

    req.on('error', (err) => done(reject, err instanceof FetchError ? err : new FetchError(describeNetworkError(err), err?.code ?? 'ENETWORK')));

    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return done(resolve, { status, location: res.headers.location });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return done(reject, new FetchError(`the site responded with HTTP ${status}`, 'ESTATUS', status));
      }
      const contentType = String(res.headers['content-type'] ?? '');
      if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        res.destroy();
        return done(reject, new FetchError(`the address is not a web page (${contentType.split(';')[0]})`, 'ECONTENTTYPE'));
      }

      const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          return done(reject, new FetchError('the page is too large to read', 'ETOOBIG'));
        }
        chunks.push(chunk);
      });
      stream.on('end', () => done(resolve, { status, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', () => done(reject, new FetchError('the page could not be decoded', 'EDECODE')));
    });

    req.end();
  });
}

/**
 * Fetches an HTML page. Throws FetchError with a readable message and a code.
 *
 * @param {string} rawUrl
 * @param {object} [options]
 * @param {number} [options.timeoutMs=8000]    across all redirect hops
 * @param {number} [options.maxBytes=1500000]  decompressed body limit
 * @param {number} [options.maxRedirects=3]
 * @param {Function} [options.lookup]          DNS lookup; tests substitute a permissive one
 * @param {Set<string>|null} [options.allowedPorts]  null allows any port (tests only)
 */
export async function fetchPage(rawUrl, { timeoutMs = 8000, maxBytes = 1_500_000, maxRedirects = 3, lookup = safeLookup, allowedPorts = STANDARD_PORTS } = {}) {
  let url = new URL(rawUrl);
  const deadline = Date.now() + timeoutMs;

  for (let hop = 0; ; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw new FetchError('only http and https pages can be read', 'EPROTOCOL');
    if (allowedPorts && !allowedPorts.has(url.port)) throw new FetchError('only pages on the standard web ports can be read', 'EPORT');
    if (url.username || url.password) throw new FetchError('addresses with credentials cannot be read', 'ECREDENTIALS');

    // Node connects to IP-literal hosts without calling `lookup`, so check those here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && lookup === safeLookup && isBlockedAddress(host)) {
      throw new FetchError('that address is not a public website', 'EBLOCKEDADDRESS');
    }

    const res = await requestOnce(url, { lookup, deadline, maxBytes });
    if (REDIRECTS.has(res.status)) {
      if (!res.location) throw new FetchError(`the site redirected (HTTP ${res.status}) without saying where`, 'EREDIRECT');
      if (hop >= maxRedirects) throw new FetchError('the site redirected too many times', 'EREDIRECT');
      url = new URL(res.location, url);
      continue;
    }
    return { url: url.href, status: res.status, html: res.body };
  }
}

// ---------- HTML to text ----------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®', trade: '™',
};

const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const cp = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });

const clean = (s) => decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim();

const parseAttributes = (tag) => {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
};

/**
 * Pulls what a model needs to describe a product out of raw HTML: title, meta
 * description (falling back to Open Graph and Twitter tags), headings, and
 * visible text. Also reports whether the page is client-rendered or noindexed,
 * which explains thin results to the user.
 */
export function extractPageContent(html) {
  const source = String(html ?? '');
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1]);

  const meta = {};
  for (const m of source.matchAll(/<meta\b[^>]*>/gi)) {
    const a = parseAttributes(m[0]);
    const key = String(a.name ?? a.property ?? '').toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = clean(a.content);
  }

  const body = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/i, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ');

  const headings = [...body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => clean(m[2].replace(/<[^>]+>/g, ' ')))
    .filter(Boolean)
    .slice(0, 20);

  const text = clean(body.replace(/<[^>]+>/g, ' '));
  const scriptCount = (source.match(/<script\b/gi) ?? []).length;
  // An empty mount point is the signature of a page that builds itself in the browser. A short
  // page that happens to load a script is not, so text length alone is not the test.
  const emptyAppRoot = /<div[^>]+id\s*=\s*["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(source);

  return {
    title: title || null,
    description: meta.description || meta['og:description'] || meta['twitter:description'] || null,
    siteName: meta['og:site_name'] || null,
    headings,
    text: text.slice(0, 8000),
    textLength: text.length,
    noindex: /\bnoindex\b/i.test(meta.robots ?? ''),
    clientRendered: emptyAppRoot || (text.length < 20 && scriptCount > 0), // under 20 chars is a "Loading…" line at most
  };
}
