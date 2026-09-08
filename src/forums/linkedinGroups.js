export default {
  id: 'linkedin-groups',
  name: 'LinkedIn Groups',
  aliases: ['linkedin', 'linkedin-group'],
  domains: ['linkedin.com'],
  threadHint:
    'A thread is a public LinkedIn group discussion or public post (URL contains "/groups/", "/posts/", or "/feed/update/"). Only include content readable without logging in.',
  voice:
    'LinkedIn: professional but human and first person. Short sentences and concrete specifics rather than abstractions. Avoid corporate abstraction and anything that sounds like a press release.',
  isThreadUrl: (url) => /^\/(groups|posts|feed\/update)\//i.test(url.pathname),
};
