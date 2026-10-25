import { theme as t, layout, button, paragraph, link } from './layout.js';

/**
 * Supabase Auth's sign-up confirmation and password reset emails, in the shared layout. The
 * {{ ... }} parts are Supabase's own template variables. Generated into supabase/templates/ by
 * scripts/build-email-templates.mjs; a test checks the committed files match.
 */
export function authTemplates() {
  const fallback = `${paragraph("If the button doesn't work, copy this link into your browser:", { size: 14, color: t.muted, margin: '0 0 8px 0' })}
              <p style="margin:0;font-family:${t.font};font-size:13px;line-height:1.5;word-break:break-all;">${link('{{ .ConfirmationURL }}', '{{ .ConfirmationURL }}')}</p>`;

  return {
    'confirm-signup.html': {
      subject: 'Confirm your helpyoufindthat account',
      html: layout({
        title: 'Confirm your helpyoufindthat account',
        preheader: 'Confirm your email to start finding people who are looking for what you offer.',
        heading: 'Confirm your email',
        bodyHtml: `${paragraph('{{ if .Data.name }}Hi {{ .Data.name }},{{ else }}Hi there,{{ end }}')}
              ${paragraph('Thanks for signing up. Confirm your email address to start finding people who are looking for what you offer. Your account comes with 300 complimentary beta credits.', { margin: '0 0 24px 0' })}
              ${button('{{ .ConfirmationURL }}', 'Confirm email')}
              ${fallback}`,
        footerHtml: "The link works once. If you didn't create an account with {{ .Email }}, you can ignore this email.",
      }),
    },
    'reset-password.html': {
      subject: 'Reset your helpyoufindthat password',
      html: layout({
        title: 'Reset your helpyoufindthat password',
        preheader: 'Use this link to choose a new password.',
        heading: 'Reset your password',
        bodyHtml: `${paragraph('We received a request to reset the password for {{ .Email }}. Choose a new one with the button below.', { margin: '0 0 24px 0' })}
              ${button('{{ .ConfirmationURL }}', 'Choose a new password')}
              ${fallback}`,
        footerHtml: "The link works once. If you didn't ask to reset your password, you can ignore this email and your password stays the same.",
      }),
    },
  };
}
