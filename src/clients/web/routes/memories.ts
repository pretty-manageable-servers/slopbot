import { Hono } from 'hono';
import { z } from 'zod';
import type { MemoryItem } from '@slopbot/contracts';
import { MEMORY_CATEGORIES, type Knowledge, type MemoryRecord } from '../../../memory.js';
import { PERSONAL_SERVER } from '../../../personal.js';
import { check } from '../body.js';
import { json, notFound, userOf, type WebEnv } from '../env.js';

/** The memory routes, mounted at /api/memories. The console checks the session, the Origin and the CSRF token before them. */
export type MemoryRoutes = Hono<WebEnv>;

const listQuery = z.object({
  query: z.string().optional(),
  scope: z.union([z.literal('personal'), z.templateLiteral(['project:', z.string().min(1)])]).optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  limit: z.coerce.number().int('Invalid limit.').min(1, 'Invalid limit.').max(100, 'Invalid limit.').default(50),
  offset: z.coerce.number().int('Invalid offset.').min(0, 'Invalid offset.').default(0),
});

/** The Memory page's view of a memory. Personal memories are "personal"; project memories keep their channel, "project:<id>". */
const item = (memory: MemoryRecord): MemoryItem => ({
  id: memory.id, content: memory.content, category: memory.category, tags: memory.tags,
  scope: memory.server === PERSONAL_SERVER ? 'personal' : memory.channel, updated: memory.updatedAt,
});

/** The signed-in user's own memories: list with search and filters, and delete. There is no edit. */
export function memoryRoutes(knowledge: Knowledge): MemoryRoutes {
  const app = new Hono<WebEnv>();

  app.get('/', async c => {
    const parsed = check(listQuery, c.req.query());
    if ('error' in parsed) return parsed.error;
    const { query, scope, category, limit, offset } = parsed.value;
    // An empty filter is no filter. The optional keys are set only when they have a value.
    const filter: Parameters<Knowledge['userMemories']>[1] = { limit, offset };
    if (query) filter.query = query;
    if (scope) filter.scope = scope;
    if (category) filter.category = category;
    const found = await knowledge.userMemories(userOf(c), filter);
    return json(200, { items: found.items.map(item), total: found.total });
  });

  app.delete('/:id', async c => (await knowledge.forgetOwn(userOf(c), c.req.param('id')))
    ? new Response(null, { status: 204 })
    : json(404, { error: 'Memory not found.' }));

  app.all('*', () => notFound());
  return app;
}
