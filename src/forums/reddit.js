export default {
  id: 'reddit',
  name: 'Reddit',
  aliases: [],
  domains: ['reddit.com'],
  threadHint:
    'A thread is a Reddit post (its URL contains "/comments/"). Look for posts asking for recommendations, alternatives, "what do you use for", "is there a tool that", or describing the problem and asking how others solve it.',
  isThreadUrl: (url) => /\/comments\/[a-z0-9]+/i.test(url.pathname),
};
