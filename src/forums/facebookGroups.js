export default {
  id: 'facebook-groups',
  name: 'Facebook Groups',
  aliases: ['facebook', 'fb', 'fb-groups', 'facebook-group'],
  domains: ['facebook.com'],
  threadHint:
    'A thread is a post inside a public Facebook group (URL contains "/groups/" followed by "/posts/" or "/permalink/"). Only include posts on public groups whose content is visible without logging in.',
  voice:
    'Facebook groups: warm, chatty and short. Casual punctuation, plain words, the way you would talk to someone in a trade group who just asked the room a question.',
  isThreadUrl: (url) => /\/groups\/[^/]+\/(posts|permalink)\//i.test(url.pathname),
};
