export default {
  id: 'quora',
  name: 'Quora',
  aliases: [],
  domains: ['quora.com'],
  threadHint:
    'A thread is a Quora question page. Look for questions asking which tool, service, or approach to use for the problem the product solves, or asking for alternatives to existing solutions.',
  voice:
    'Quora: fuller prose that answers the question directly, a little more explanatory than a forum comment, still first person and conversational rather than academic.',
  isThreadUrl: (url) => url.pathname.length > 1 && !/^\/(profile|topic|search|about)\b/i.test(url.pathname),
};
