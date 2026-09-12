export default {
  id: 'facebook-groups',
  name: 'Facebook Groups',
  aliases: ['facebook', 'fb', 'fb-groups', 'facebook-group'],
  domains: ['facebook.com'],
  voice:
    'Facebook groups: warm, chatty and short. Casual punctuation, plain words, the way you would talk to someone in a trade group who just asked the room a question.',
  isThreadUrl: (url) => /\/groups\/[^/]+\/(posts|permalink)\//i.test(url.pathname),
};
