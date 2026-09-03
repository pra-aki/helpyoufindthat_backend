export default {
  id: 'hackernews',
  name: 'Hacker News',
  aliases: ['hacknews', 'hn', 'hacker-news', 'news.ycombinator.com', 'ycombinator'],
  domains: ['news.ycombinator.com'],
  threadHint:
    'A thread is a Hacker News item page (URL is /item?id=NUMBER). Prioritise "Ask HN" posts and comment threads where someone asks for a tool, service, or approach, or describes the problem they cannot solve.',
  isThreadUrl: (url) => url.pathname === '/item' && /^\d+$/.test(url.searchParams.get('id') ?? ''),
};
