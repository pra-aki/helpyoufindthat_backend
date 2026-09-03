export default {
  id: 'linkedin-groups',
  name: 'LinkedIn Groups',
  aliases: ['linkedin', 'linkedin-group'],
  domains: ['linkedin.com'],
  threadHint:
    'A thread is a public LinkedIn group discussion or public post (URL contains "/groups/", "/posts/", or "/feed/update/"). Only include content readable without logging in.',
  isThreadUrl: (url) => /^\/(groups|posts|feed\/update)\//i.test(url.pathname),
};
