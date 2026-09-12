export default {
  id: 'hackernews',
  name: 'Hacker News',
  aliases: ['hacknews', 'hn', 'hacker-news', 'news.ycombinator.com', 'ycombinator'],
  domains: ['news.ycombinator.com'],
  voice:
    'Hacker News: plain, dry, understated. Complete sentences, no hype, no adjectives doing persuasive work. Specifics and tradeoffs land; enthusiasm does not. Saying what the thing does not do buys credibility.',
  isThreadUrl: (url) => url.pathname === '/item' && /^\d+$/.test(url.searchParams.get('id') ?? ''),
};
