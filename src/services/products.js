/**
 * Product storage, scoped to the calling user by row-level security.
 * Rows are returned in camelCase to match the rest of the API.
 */
const toApi = (row) =>
  row && {
    id: row.id,
    name: row.name,
    website: row.website ?? null,
    description: row.description,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

export function createProductsService(db) {
  return {
    async create(token, user, { name, website, description }) {
      const row = await db.insert(token, 'products', { name, website: website ?? null, description, user_id: user.id });
      return toApi(row);
    },

    async list(token) {
      const rows = await db.select(token, 'products', { select: '*', order: 'created_at.desc' });
      return (rows ?? []).map(toApi);
    },

    async get(token, id) {
      const row = await db.selectOne(token, 'products', { select: '*', id: `eq.${id}` });
      return toApi(row);
    },
  };
}
