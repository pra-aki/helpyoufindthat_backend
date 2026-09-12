export default {
  id: 'reddit',
  name: 'Reddit',
  aliases: [],
  domains: ['reddit.com'],
  voice:
    'Reddit: casual and blunt. Contractions, short paragraphs, sometimes a sentence fragment. Plain talk with no polish, and answers get to the point fast. Self-promotion is punished here, so the disclosure has to read as offhand honesty, not a pitch.',
  isThreadUrl: (url) => /\/comments\/[a-z0-9]+/i.test(url.pathname),
};
