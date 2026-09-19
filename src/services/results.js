/**
 * Stored search results. One row per (product, link); repeat finds refresh
 * search_date and the score rather than adding rows.
 */
const toApi = (row) =>
  row && {
    id: row.id,
    productId: row.product_id,
    source: row.source_site,
    link: row.link,
    title: row.title ?? null,
    summary: row.summary ?? null,
    whyRelevant: row.why_relevant ?? null,
    postedAt: row.posted_at ?? null,
    relevanceScore: row.relevance_score === null || row.relevance_score === undefined ? null : Number(row.relevance_score),
    searchDate: row.search_date,
    createdAt: row.created_at,
  };

const toTimestamp = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// PostgREST splits in.(...) on commas, so each value is quoted; links can contain commas.
const quoteForIn = (value) => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;

export function createResultsService(db) {
  return {
    /**
     * Which of `links` are already stored under the product. One query, served by the
     * (product_id, link) unique index.
     */
    async existingLinks(token, productId, links) {
      if (links.length === 0) return new Set();
      const rows = await db.select(token, 'search_results', {
        select: 'link',
        product_id: `eq.${productId}`,
        link: `in.(${links.map(quoteForIn).join(',')})`,
      });
      return new Set((rows ?? []).map((r) => r.link));
    },

    /**
     * Upserts the threads from one search under a product. Returns the stored rows in the same
     * order, each with `isNew`: true when this search stored the link for the first time.
     */
    async save(token, productId, threads, { searchDate = new Date() } = {}) {
      if (threads.length === 0) return [];
      const seen = new Set();
      const rows = [];
      for (const t of threads) {
        if (seen.has(t.url)) continue; // PostgREST rejects a batch that hits the same key twice
        seen.add(t.url);
        rows.push({
          product_id: productId,
          source_site: t.source,
          link: t.url,
          title: t.title || null,
          summary: t.summary || null,
          why_relevant: t.whyRelevant || null,
          posted_at: toTimestamp(t.postedAt),
          relevance_score: Math.round(t.relevanceScore * 1000) / 1000,
          search_date: searchDate.toISOString(),
        });
      }
      // Read before writing: after the upsert every row looks the same, so this is the only
      // moment the difference between a first find and a repeat find exists.
      const before = await this.existingLinks(token, productId, rows.map((r) => r.link));
      const stored = await db.upsert(token, 'search_results', rows, { onConflict: 'product_id,link' });
      const byLink = new Map(stored.map((r) => [r.link, { ...toApi(r), isNew: !before.has(r.link) }]));
      return rows.map((r) => byLink.get(r.link)).filter(Boolean);
    },

    /** Deletes the given result ids under a product. Returns the ids actually deleted. */
    async remove(token, productId, ids) {
      if (ids.length === 0) return [];
      const rows = await db.remove(token, 'search_results', { product_id: `eq.${productId}`, id: `in.(${ids.join(',')})`, select: 'id' });
      return rows.map((r) => r.id);
    },

    /** Pages through a product's stored results, latest search first, then by score. */
    async list(token, productId, { limit, offset, source, minScore }) {
      const query = {
        select: '*',
        product_id: `eq.${productId}`,
        order: 'search_date.desc,relevance_score.desc.nullslast,created_at.desc',
        limit: String(limit),
        offset: String(offset),
        source_site: source ? `eq.${source}` : undefined,
        relevance_score: minScore !== undefined ? `gte.${minScore}` : undefined,
      };
      const { rows, total } = await db.selectPage(token, 'search_results', query);
      return { results: rows.map(toApi), total };
    },
  };
}
