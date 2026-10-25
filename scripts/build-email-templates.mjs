#!/usr/bin/env node
/**
 * Writes Supabase Auth's email templates into supabase/templates/ from the shared layout, so the
 * sign-up and password reset emails look exactly like the job lead emails and the front end.
 *
 *   npm run email-templates
 *
 * The {{ ... }} parts are Supabase's template variables, filled in by Supabase when it sends. After
 * running this, paste each file into the dashboard under Authentication > Emails > Templates.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authTemplates } from '../src/email/authTemplates.js';

const dir = fileURLToPath(new URL('../supabase/templates/', import.meta.url));
for (const [file, { html }] of Object.entries(authTemplates())) {
  writeFileSync(dir + file, html);
  console.log(`wrote supabase/templates/${file}`);
}
