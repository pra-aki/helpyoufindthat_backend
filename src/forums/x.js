export default {
  id: 'x',
  name: 'X (Twitter)',
  aliases: ['twitter', 'x.com', 'twitter.com'],
  domains: ['x.com', 'twitter.com'],
  voice:
    'X: very short and clipped. One or two sentences, often lowercase, no preamble, no throat-clearing. Say the useful thing and stop.',
  isThreadUrl: (url) => /\/status\/\d+/i.test(url.pathname),
};
