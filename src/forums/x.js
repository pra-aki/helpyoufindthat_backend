export default {
  id: 'x',
  name: 'X (Twitter)',
  aliases: ['twitter', 'x.com', 'twitter.com'],
  domains: ['x.com', 'twitter.com'],
  threadHint:
    'A thread is a public post or reply thread (URL contains "/status/"). Look for posts asking followers for recommendations, "anyone know a tool for", or venting about a problem the product solves.',
  voice:
    'X: very short and clipped. One or two sentences, often lowercase, no preamble, no throat-clearing. Say the useful thing and stop.',
  isThreadUrl: (url) => /\/status\/\d+/i.test(url.pathname),
};
