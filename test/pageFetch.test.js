import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { fetchPage, isBlockedAddress, extractPageContent } from '../src/services/pageFetch.js';

// ---------- address blocking ----------

test('isBlockedAddress refuses private, loopback, link-local, metadata, and reserved addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '104.21.11.38', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

const refuses = (url, code) => assert.rejects(fetchPage(url), (e) => e.code === code, `${url} should be refused with ${code}`);

test('fetchPage refuses internal addresses, including IP literals Node would connect to without a lookup', async () => {
  await refuses('http://127.0.0.1/', 'EBLOCKEDADDRESS');
  await refuses('http://[::1]/', 'EBLOCKEDADDRESS');
  await refuses('http://2130706433/', 'EBLOCKEDADDRESS'); // decimal form of 127.0.0.1
  await refuses('http://0x7f.0.0.1/', 'EBLOCKEDADDRESS');
  await refuses('http://169.254.169.254/latest/meta-data/', 'EBLOCKEDADDRESS');
  await refuses('http://192.168.0.1/', 'EBLOCKEDADDRESS');
  await refuses('http://localhost/', 'EBLOCKEDADDRESS'); // via DNS
});

test('fetchPage refuses other schemes, non-standard ports, and embedded credentials before connecting', async () => {
  await refuses('ftp://example.com/', 'EPROTOCOL');
  await refuses('http://example.com:8080/', 'EPORT');
  await refuses('http://user:pass@example.com/', 'ECREDENTIALS');
});

// ---------- behaviour against a local server (blocking relaxed for the test only) ----------

const openLookup = (hostname, options, cb) => dns.lookup(hostname, options, cb);
const local = { lookup: openLookup, allowedPorts: null };
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const html = (body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    switch (req.url) {
      case '/page': return html('<html><head><title>Hi</title></head><body><h1>Hello</h1></body></html>');
      case '/redirect': res.writeHead(302, { location: '/page' }); return res.end();
      case '/loop': res.writeHead(302, { location: '/loop' }); return res.end();
      case '/to-internal': res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end();
      case '/pdf': res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF');
      case '/missing': res.writeHead(404, { 'content-type': 'text/html' }); return res.end('nope');
      case '/big': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('x'.repeat(5000));
      case '/gzip': res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync('<title>Zipped</title>'));
      case '/slow': return; // never responds
      default: res.writeHead(500); return res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.closeAllConnections?.() ?? server.close());

test('fetchPage reads HTML, follows redirects, and decompresses gzip', async () => {
  assert.match((await fetchPage(`${base}/page`, local)).html, /<h1>Hello<\/h1>/);
  const redirected = await fetchPage(`${base}/redirect`, local);
  assert.equal(redirected.url, `${base}/page`);
  assert.match(redirected.html, /Hello/);
  assert.equal((await fetchPage(`${base}/gzip`, local)).html, '<title>Zipped</title>');
});

test('fetchPage stops on redirect loops, non-HTML, error statuses, oversize bodies, and slow sites', async () => {
  const fails = (path, code, opts = {}) => assert.rejects(fetchPage(`${base}${path}`, { ...local, ...opts }), (e) => e.code === code, `${path} -> ${code}`);
  await fails('/loop', 'EREDIRECT', { maxRedirects: 2 });
  await fails('/pdf', 'ECONTENTTYPE');
  await fails('/missing', 'ESTATUS');
  await fails('/big', 'ETOOBIG', { maxBytes: 1000 });
  await fails('/slow', 'ETIMEDOUT', { timeoutMs: 200 });
});

test('a redirect to an internal address is refused on the next hop', async () => {
  // Blocking applies to IP literals whenever the real lookup is in use, including after a redirect.
  await assert.rejects(fetchPage(`${base}/to-internal`, { allowedPorts: null, lookup: undefined }), (e) => e.code === 'EBLOCKEDADDRESS');
});

// ---------- extraction ----------

const SPA = `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8" />
  <title>Lead Portal</title>
  <meta content="Finds people asking for what you sell &amp; tells you." name="description" />
  <meta name="robots" content="noindex, nofollow" />
  <script type="module" src="/assets/index.js"></script>
</head><body><div id="root"></div></body></html>`;

test('extractPageContent on a client-rendered page reports metadata only, noindex, and client rendering', () => {
  const c = extractPageContent(SPA);
  assert.equal(c.title, 'Lead Portal');
  assert.equal(c.description, 'Finds people asking for what you sell & tells you.', 'attribute order does not matter and entities are decoded');
  assert.equal(c.textLength, 0);
  assert.equal(c.noindex, true);
  assert.equal(c.clientRendered, true);
});

test('extractPageContent on a server-rendered page returns headings and visible text without scripts or styles', () => {
  const html = `<html><head><title>Acme</title><meta property="og:description" content="OG text"><meta property="og:site_name" content="Acme Inc"></head>
  <body><style>.x{color:red}</style><script>var secret = 1;</script><!-- comment -->
  <h1>Follow up <em>faster</em></h1><p>Acme reminds landscapers to call back every lead&nbsp;before it goes cold. It works from your phone.</p>
  <h2>Pricing</h2><p>Plans for small crews.</p><noscript>enable js</noscript></body></html>`;
  const c = extractPageContent(html);
  assert.equal(c.description, 'OG text', 'falls back to Open Graph');
  assert.equal(c.siteName, 'Acme Inc');
  assert.deepEqual(c.headings, ['Follow up faster', 'Pricing']);
  assert.match(c.text, /Acme reminds landscapers to call back every lead before it goes cold/);
  assert.ok(!/secret|color:red|comment|enable js/.test(c.text), 'scripts, styles, comments and noscript are stripped');
  assert.equal(c.clientRendered, false);
  assert.equal(c.noindex, false);
});

test('client rendering is detected by an empty mount point or no text, not by a page merely being short', () => {
  assert.equal(extractPageContent('<body><div id="app"> </div><script src="/x.js"></script></body>').clientRendered, true);
  assert.equal(extractPageContent('<body><script src="/x.js"></script></body>').clientRendered, true, 'no text at all plus a script');
  assert.equal(extractPageContent('<body><h1>Acme</h1><p>Reminds you to call leads back.</p><script src="/analytics.js"></script></body>').clientRendered, false, 'short but real content');
});
