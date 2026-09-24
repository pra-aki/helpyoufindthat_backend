// Runs every due search job once and exits. For an external scheduler (a Render Cron Job,
// crontab) when the web service is not always on. `npm run jobs`.
import { loadConfig } from '../config.js';
import { createSupabaseRest } from '../services/supabaseRest.js';
import { createJobsService } from '../services/jobs.js';
import { createResultsService } from '../services/results.js';
import { createSearchLogService } from '../services/searchLog.js';
import { createMailer } from '../services/mailer.js';
import { createCreditsService } from '../services/credits.js';
import { createJobRunner } from './runner.js';

const config = loadConfig();
if (!config.supabase.serviceRoleKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is not set; jobs cannot run.');
  process.exit(2);
}
const db = createSupabaseRest(config.supabase);
const runner = createJobRunner({
  config,
  db,
  jobs: createJobsService(db),
  results: createResultsService(db),
  searchLog: createSearchLogService(db),
  mailer: createMailer(config.email),
  credits: createCreditsService(db, { serviceToken: config.supabase.serviceRoleKey }),
});
const outcomes = await runner.runDueJobs();
for (const o of outcomes) {
  console.log(
    o.status === 'ok'
      ? `job ${o.jobId}: ${o.from}..${o.to} found ${o.foundCount}, leads ${o.leadCount}, new ${o.newLeadCount}, email ${o.emailStatus}${o.completed ? ', completed' : ''}`
      : `job ${o.jobId}: ${o.from}..${o.to} failed: ${o.error}${o.completed ? ', completed' : ''}`,
  );
}
console.log(`${outcomes.length} job${outcomes.length === 1 ? '' : 's'} ran`);
