export default {
  id: 'quora',
  name: 'Quora',
  aliases: [],
  domains: ['quora.com'],
  voice:
    'Quora: fuller prose that answers the question directly, a little more explanatory than a forum comment, still first person and conversational rather than academic.',
  isThreadUrl: (url) => url.pathname.length > 1 && !/^\/(profile|topic|search|about)\b/i.test(url.pathname),
};
