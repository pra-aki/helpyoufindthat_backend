import { isoDay } from '../validation.js';
import { theme as t, escapeHtml, layout, button, paragraph, link } from '../email/layout.js';

const percent = (score) => `${Math.round(Number(score) * 100)}%`;

/**
 * The daily email for a job run: one entry per new lead, with the link, where it was found, the
 * score, what the author asks for, and the summary, then a button to the job's leads in the app.
 * Styled like the front end through the shared layout. Returns { subject, text, html }.
 *
 * @param {object} args
 * @param {string} [args.appUrl]  the front end's address, for links back into the app
 */
export function leadsEmail({ product, job, leads, from, to, appUrl = 'https://helpyoufindthat.com' }) {
  const base = appUrl.replace(/\/+$/, '');
  const leadsUrl = `${base}/dashboard/products/${encodeURIComponent(job.productId)}/jobs/${encodeURIComponent(job.id)}/leads`;
  const settingsUrl = `${base}/dashboard/profile`;

  const n = leads.length;
  const window = isoDay(from) === isoDay(to) ? isoDay(to) : `${isoDay(from)} to ${isoDay(to)}`;
  const subject = `${n} new lead${n === 1 ? '' : 's'} for ${product.name}`;
  const intro = `Your daily search for ${product.name} found ${n} new thread${n === 1 ? '' : 's'} (${window}) where someone is looking for what it does, scored ${percent(job.minScore)} or higher.`;
  const stop = `This job runs every day until ${job.endDate}. To stop these emails, turn off job emails under Email notifications in your profile settings, or cancel the job.`;

  const textLines = [intro, ''];
  for (const lead of leads) {
    textLines.push(`${lead.title || lead.url}`);
    textLines.push(`  ${lead.url}`);
    textLines.push(`  ${lead.source} · relevance ${percent(lead.relevanceScore)}${lead.postedAt ? ` · posted ${String(lead.postedAt).slice(0, 10)}` : ''}`);
    if (lead.asksFor) textLines.push(`  Asks for: ${lead.asksFor}`);
    if (lead.summary) textLines.push(`  ${lead.summary}`);
    textLines.push('');
  }
  textLines.push(`View all leads: ${leadsUrl}`, '', stop, `Profile settings: ${settingsUrl}`);

  const items = leads
    .map((lead) => {
      const meta = `${escapeHtml(lead.source)} · ${percent(lead.relevanceScore)} match${lead.postedAt ? ` · posted ${escapeHtml(String(lead.postedAt).slice(0, 10))}` : ''}`;
      return `<tr>
                  <td style="padding:16px 0;border-top:1px solid ${t.border};font-family:${t.font};">
                    <a href="${escapeHtml(lead.url)}" target="_blank" style="font-size:16px;line-height:1.4;font-weight:500;color:${t.primary};text-decoration:none;">${escapeHtml(lead.title || lead.url)}</a>
                    <div style="margin-top:4px;font-size:13px;line-height:1.5;color:${t.muted};">${meta}</div>
                    ${lead.asksFor ? `<div style="margin-top:10px;padding:8px 12px;border-radius:6px;background-color:${t.secondary};font-size:14px;line-height:1.5;color:${t.foreground};"><span style="color:${t.muted};">Asks for:</span> ${escapeHtml(lead.asksFor)}</div>` : ''}
                    ${lead.summary ? `<div style="margin-top:8px;font-size:14px;line-height:1.6;color:${t.foreground};">${escapeHtml(lead.summary)}</div>` : ''}
                  </td>
                </tr>`;
    })
    .join('\n');

  const bodyHtml = `${paragraph(escapeHtml(intro), { margin: '0 0 8px 0' })}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;border-bottom:1px solid ${t.border};">
                ${items}
              </table>
              ${button(escapeHtml(leadsUrl), 'View all leads')}`;

  const html = layout({
    title: subject,
    preheader: intro,
    heading: escapeHtml(`${n} new lead${n === 1 ? '' : 's'} for ${product.name}`),
    bodyHtml,
    footerHtml: `This job runs every day until ${escapeHtml(job.endDate)}. To stop these emails, turn off job emails under Email notifications in your ${link(escapeHtml(settingsUrl), 'profile settings')}, or cancel the job.`,
  });

  return { subject, text: textLines.join('\n'), html };
}
