export default {
  id: 'reddit',
  name: 'Reddit',
  aliases: [],
  domains: ['reddit.com'],
  threadHint:
    'A thread is a Reddit post (its URL contains "/comments/"). Look for posts asking for recommendations, alternatives, "what do you use for", "is there a tool that", or describing the problem and asking how others solve it.',
  voice:
    'Reddit: casual and blunt. Contractions, short paragraphs, sometimes a sentence fragment. Plain talk with no polish, and answers get to the point fast. Self-promotion is punished here, so the disclosure has to read as offhand honesty, not a pitch.',
  isThreadUrl: (url) => /\/comments\/[a-z0-9]+/i.test(url.pathname),
};
