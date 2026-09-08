export default {
  id: 'reddit',
  name: 'Reddit',
  aliases: [],
  domains: ['reddit.com'],
  threadHint:
    'A thread is a Reddit post (its URL contains "/comments/"). Look for posts asking for recommendations, alternatives, "what do you use for", "is there a tool that", or describing the problem and asking how others solve it.',
  voice:
    'Reddit: casual and blunt. Contractions, short paragraphs, sometimes a sentence fragment. People lead with their own experience ("we had this exact problem") before giving advice. Self-promotion is punished here, so the disclosure has to read as offhand honesty, not a pitch.',
  isThreadUrl: (url) => /\/comments\/[a-z0-9]+/i.test(url.pathname),
};
