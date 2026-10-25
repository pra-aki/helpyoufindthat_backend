/**
 * The shared look of every email the product sends: the job lead emails built here, and Supabase
 * Auth's sign-up and password reset templates, generated from this file by
 * scripts/build-email-templates.mjs. It mirrors the front end's theme (src/styles/theme.css in the
 * client): the ivory page and card, the rose-tinted border, the red primary with ivory text,
 * medium-weight headings, the system font, and the "H" logo with "help you Find That".
 *
 * Email clients ignore stylesheets and much of CSS, so everything is tables with inline styles,
 * and colours with transparency are flattened to solid ones.
 */

export const theme = Object.freeze({
  background: '#FFFFF0',
  foreground: '#2b2b2b',
  muted: '#6b6b6b',
  primary: '#B8444A',
  primaryForeground: '#FFFFF0',
  secondary: '#f5e6d3',
  // The front end's border is the primary at 15% over the ivory background; email needs it solid.
  border: '#F4E3D7',
  font: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
});

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const t = theme;

/** The header logo, in text so no image has to load: a red rounded "H", then the wordmark. */
const logo = `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="32" height="32" align="center" valign="middle" bgcolor="${t.primary}" style="width:32px;height:32px;border-radius:8px;background-color:${t.primary};color:${t.primaryForeground};font-family:${t.font};font-size:16px;font-weight:700;line-height:32px;">H</td>
              <td style="padding-left:8px;font-family:${t.font};white-space:nowrap;"><span style="font-family:cursive;font-size:14px;color:${t.muted};">help you</span> <span style="font-size:20px;font-weight:700;color:${t.foreground};">Find That</span></td>
            </tr>
          </table>`;

/** The primary button, built as a table cell so it keeps its colour and shape in every client. */
export function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
                <tr>
                  <td align="center" bgcolor="${t.primary}" style="border-radius:6px;background-color:${t.primary};">
                    <a href="${href}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${t.font};font-size:15px;font-weight:500;line-height:1.2;color:${t.primaryForeground};text-decoration:none;border-radius:6px;">${label}</a>
                  </td>
                </tr>
              </table>`;
}

/** A paragraph in the card's body text. */
export const paragraph = (html, { size = 16, color = t.foreground, margin = '0 0 16px 0' } = {}) =>
  `<p style="margin:${margin};font-family:${t.font};font-size:${size}px;line-height:1.6;color:${color};">${html}</p>`;

/** A link in the primary colour. */
export const link = (href, label) => `<a href="${href}" target="_blank" style="color:${t.primary};text-decoration:underline;">${label}</a>`;

/**
 * A whole email: the logo, a card with a heading and body, and a footer. `title` and `preheader`
 * are plain text and escaped here; `bodyHtml` and `footerHtml` are trusted HTML from the caller.
 */
export function layout({ title, preheader, heading, bodyHtml, footerHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${t.background};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${t.background}" style="background-color:${t.background};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
          <tr>
            <td style="padding:0 0 20px 0;">
          ${logo}
            </td>
          </tr>
          <tr>
            <td bgcolor="${t.background}" style="background-color:${t.background};border:1px solid ${t.border};border-radius:12px;padding:32px 28px;font-family:${t.font};color:${t.foreground};">
              <h1 style="margin:0 0 16px 0;font-family:${t.font};font-size:22px;line-height:1.4;font-weight:500;color:${t.foreground};">${heading}</h1>
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 4px 0 4px;font-family:${t.font};font-size:13px;line-height:1.6;color:${t.muted};">
              ${footerHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}
