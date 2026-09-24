import { isoDay } from '../validation.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const percent = (score) => `${Math.round(Number(score) * 100)}%`;

/**
 * The daily email for a job run: one entry per new lead, with the link, where it was found,
 * the score, what the author asks for, and the summary. Returns { subject, text, html }.
 */
export function leadsEmail({ product, job, leads, from, to }) {
  const n = leads.length;
  const window = isoDay(from) === isoDay(to) ? isoDay(to) : `${isoDay(from)} to ${isoDay(to)}`;
  const subject = `${n} new lead${n === 1 ? '' : 's'} for ${product.name}`;
  const intro = `Your daily search for ${product.name} found ${n} new thread${n === 1 ? '' : 's'} (${window}) where someone is looking for what it does, scored ${percent(job.minScore)} or higher.`;

  const textLines = [intro, ''];
  for (const lead of leads) {
    textLines.push(`${lead.title || lead.url}`);
    textLines.push(`  ${lead.url}`);
    textLines.push(`  ${lead.source} · relevance ${percent(lead.relevanceScore)}${lead.postedAt ? ` · posted ${String(lead.postedAt).slice(0, 10)}` : ''}`);
    if (lead.asksFor) textLines.push(`  Asks for: ${lead.asksFor}`);
    if (lead.summary) textLines.push(`  ${lead.summary}`);
    textLines.push('');
  }
  textLines.push(`This job runs every day until ${job.endDate}. Cancel it from the app if you no longer want these emails.`);

  const items = leads
    .map(
      (lead) => `
      <li style="margin:0 0 18px 0">
        <a href="${escapeHtml(lead.url)}" style="font-weight:600;color:#1a56db;text-decoration:none">${escapeHtml(lead.title || lead.url)}</a><br>
        <span style="color:#555;font-size:13px">${escapeHtml(lead.source)} · relevance ${percent(lead.relevanceScore)}${lead.postedAt ? ` · posted ${escapeHtml(String(lead.postedAt).slice(0, 10))}` : ''}</span>
        ${lead.asksFor ? `<div style="margin-top:4px"><strong>Asks for:</strong> ${escapeHtml(lead.asksFor)}</div>` : ''}
        ${lead.summary ? `<div style="margin-top:4px;color:#333">${escapeHtml(lead.summary)}</div>` : ''}
      </li>`,
    )
    .join('');

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45;color:#111;max-width:640px;margin:0 auto;padding:24px">
  <p>${escapeHtml(intro)}</p>
  <ol style="padding-left:20px">${items}</ol>
  <p style="color:#777;font-size:13px">This job runs every day until ${escapeHtml(job.endDate)}. Cancel it from the app if you no longer want these emails.</p>
</body></html>`;

  return { subject, text: textLines.join('\n'), html };
}
