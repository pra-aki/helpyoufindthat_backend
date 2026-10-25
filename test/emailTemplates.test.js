import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authTemplates } from '../src/email/authTemplates.js';
import { theme, layout } from '../src/email/layout.js';

test('the committed Supabase templates are exactly what the shared layout generates', () => {
  for (const [file, { html }] of Object.entries(authTemplates())) {
    const committed = readFileSync(new URL(`../supabase/templates/${file}`, import.meta.url), 'utf8');
    assert.equal(committed, html, `${file} is out of date: run npm run email-templates`);
  }
});

test('Supabase\'s template variables survive untouched, and the look matches the front end', () => {
  const { 'confirm-signup.html': confirm, 'reset-password.html': reset } = authTemplates();
  assert.ok(confirm.html.includes('href="{{ .ConfirmationURL }}"'), 'the button link is left for Supabase to fill in');
  assert.ok(confirm.html.includes('{{ if .Data.name }}Hi {{ .Data.name }},{{ else }}Hi there,{{ end }}'));
  assert.ok(reset.html.includes('{{ .Email }}'));
  for (const { html } of [confirm, reset]) {
    for (const colour of [theme.background, theme.primary, theme.primaryForeground, theme.border]) assert.ok(html.includes(colour));
    assert.match(html, /Find That/);
  }
});

test('layout escapes its plain text fields', () => {
  const html = layout({ title: 'A <b>', preheader: 'P & Q', heading: 'H', bodyHtml: '<p>body</p>', footerHtml: 'f' });
  assert.ok(html.includes('<title>A &lt;b&gt;</title>'));
  assert.ok(html.includes('P &amp; Q'));
  assert.ok(html.includes('<p>body</p>'), 'body HTML is the caller\'s and is kept as is');
});
