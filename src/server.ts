import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HelpjuiceClient, Json, htmlToText, readableArticle, slimArticle, toHtml } from "./client.js";

export const VERSION = "0.1.0";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

const articleId = z.number().int().positive().describe("Article ID (from search_knowledge_base or list_articles)");
const categoryId = z.number().int().positive().describe("Category ID (from list_categories)");
const paging = {
  page: z.number().int().min(1).optional().describe("Page number (default 1)"),
  limit: z.number().int().min(1).max(1000).optional().describe("Items per page (default 25, max 1000)"),
};
const accessibility = z
  .enum(["internal", "public", "private"])
  .optional()
  .describe("public = everyone, internal = signed-in staff, private = specific users/groups");
const ACCESS_CODE = { internal: 0, public: 1, private: 2 } as const;
const RO = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

function pagination(meta: Json | undefined) {
  return meta ? { page: meta.current, total_pages: meta.total_pages, total_count: meta.total_count } : undefined;
}

export function createServer(client: HelpjuiceClient, now: () => Date = () => new Date()): McpServer {
  const server = new McpServer({ name: "helpjuice-mcp", version: VERSION });

  server.registerTool(
    "search_knowledge_base",
    {
      title: "Search knowledge base",
      description:
        "Full-text search across the Helpjuice knowledge base. Returns matching articles with a short text sample. Use get_article to read the full answer before quoting it.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for, e.g. 'reset password' or 'SSO setup'"),
        categoryId: categoryId.optional().describe("Only search inside this category"),
      },
      annotations: RO,
    },
    async ({ query, categoryId }) =>
      run(async () => {
        const res = await client.search(query, categoryId);
        return (res.searches ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          sample: s.answer_sample ? htmlToText(String(s.answer_sample)) : undefined,
          categories: Array.isArray(s.categories) ? s.categories.map((c: Json) => c.name ?? c) : undefined,
          tags: s.tag_names,
          published: s.is_published,
          last_published: s.last_published_date,
        }));
      }),
  );

  server.registerTool(
    "get_article",
    {
      title: "Read article",
      description:
        "Read one article. Returns the body as clean plain text by default (internal blocks expanded), or as HTML for editing.",
      inputSchema: {
        articleId,
        format: z.enum(["text", "html"]).optional().describe("Body format (default text)"),
        language: z.string().optional().describe("Knowledge base language code, e.g. 'fr'. Falls back to the default language"),
      },
      annotations: RO,
    },
    async ({ articleId, format, language }) =>
      run(async () => {
        const { article } = await client.getArticle(articleId, { processed: true, kb_language: language });
        return readableArticle(article, format ?? "text");
      }),
  );

  server.registerTool(
    "list_articles",
    {
      title: "List articles",
      description: "List articles with filters (category, published, visibility, created/updated dates, language). Returns compact rows.",
      inputSchema: {
        ...paging,
        categoryId: categoryId.optional(),
        published: z.boolean().optional().describe("true = published only, false = drafts only"),
        accessibility,
        createdSince: z.string().optional().describe("ISO date, e.g. 2026-09-01"),
        updatedSince: z.string().optional().describe("ISO date"),
        language: z.string().optional().describe("Language code"),
      },
      annotations: RO,
    },
    async (q) =>
      run(async () => {
        const res = await client.listArticles({
          page: q.page,
          limit: q.limit,
          category_id: q.categoryId,
          is_published: q.published,
          accessibility: q.accessibility ? ACCESS_CODE[q.accessibility] : undefined,
          created_since: q.createdSince,
          updated_since: q.updatedSince,
          language: q.language,
        });
        return { articles: (res.articles ?? []).map(slimArticle), pagination: pagination(res.meta) };
      }),
  );

  server.registerTool(
    "find_stale_articles",
    {
      title: "Find stale articles",
      description:
        "Find published articles that have not been updated in N days (default 180), oldest first. Useful for content audits before a release.",
      inputSchema: {
        days: z.number().int().min(1).max(3650).optional().describe("Not updated for at least this many days (default 180)"),
        categoryId: categoryId.optional(),
        limit: z.number().int().min(1).max(1000).optional().describe("Max articles to scan (default 200)"),
      },
      annotations: RO,
    },
    async ({ days, categoryId, limit }) =>
      run(async () => {
        const d = days ?? 180;
        const cutoff = new Date(now().getTime() - d * 86400000);
        const res = await client.listArticles({
          limit: limit ?? 200,
          category_id: categoryId,
          is_published: true,
          updated_upto: cutoff.toISOString().slice(0, 10),
        });
        const stale = (res.articles ?? [])
          .filter((a) => !a.updated_at || new Date(a.updated_at) <= cutoff)
          .sort((a, b) => String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? "")))
          .map((a) => ({
            ...slimArticle(a),
            days_since_update: a.updated_at ? Math.floor((now().getTime() - new Date(a.updated_at).getTime()) / 86400000) : null,
          }));
        return { cutoff: cutoff.toISOString().slice(0, 10), count: stale.length, articles: stale };
      }),
  );

  server.registerTool(
    "create_article",
    {
      title: "Create article",
      description:
        "Create a new article. Saved as an unpublished draft unless published=true. body accepts HTML or plain text (blank lines become paragraphs).",
      inputSchema: {
        name: z.string().min(1).describe("Article title"),
        body: z.string().min(1).describe("Article content, HTML or plain text"),
        description: z.string().optional().describe("Short summary shown in listings and search"),
        categoryIds: z.array(z.number().int().positive()).optional().describe("Categories to place it in"),
        codename: z.string().optional().describe("URL slug, e.g. 'reset-your-password'"),
        published: z.boolean().optional().describe("Publish immediately (default false = draft)"),
        language: z.string().optional().describe("Knowledge base language code for this article"),
      },
      annotations: WRITE,
    },
    async ({ name, body, description, categoryIds, codename, published, language }) =>
      run(async () => {
        const { article } = await client.createArticle(
          { name, body: toHtml(body), description, codename, category_ids: categoryIds, published: published ?? false },
          language,
        );
        return slimArticle(article ?? {});
      }),
  );

  server.registerTool(
    "update_article",
    {
      title: "Update article",
      description:
        "Update an article's title, body, summary, categories or published state. Only the fields you pass are changed. Read the article first with get_article(format='html') when editing the body.",
      inputSchema: {
        articleId,
        name: z.string().optional(),
        body: z.string().optional().describe("New full content, HTML or plain text"),
        description: z.string().optional(),
        categoryIds: z.array(z.number().int().positive()).optional(),
        published: z.boolean().optional(),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ articleId, name, body, description, categoryIds, published }) =>
      run(async () => {
        const { article } = await client.updateArticle(articleId, {
          name,
          body: body !== undefined ? toHtml(body) : undefined,
          description,
          category_ids: categoryIds,
          published,
        });
        return slimArticle(article ?? { id: articleId });
      }),
  );

  server.registerTool(
    "delete_article",
    {
      title: "Delete article",
      description: "Delete an article from the knowledge base. Confirm with the user first; consider unpublishing instead.",
      inputSchema: { articleId },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ articleId }) => run(() => client.deleteArticle(articleId)),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description: "List knowledge base categories (id, name, parent, visibility, article counts).",
      inputSchema: { language: z.string().optional().describe("Language code") },
      annotations: RO,
    },
    async ({ language }) =>
      run(async () => {
        const res = await client.listCategories(language);
        return (res.categories ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          parent_id: c.parent_id,
          description: c.description || undefined,
          accessibility: c.accessibility,
          url: c.url,
          published_articles: Array.isArray(c.published_questions) ? c.published_questions.length : c.published_questions,
          draft_articles: Array.isArray(c.draft_questions) ? c.draft_questions.length : c.draft_questions,
        }));
      }),
  );

  server.registerTool(
    "get_category",
    {
      title: "Get category",
      description: "Get one category with its published and draft articles.",
      inputSchema: { categoryId },
      annotations: RO,
    },
    async ({ categoryId }) =>
      run(async () => {
        const { category } = await client.getCategory(categoryId);
        return {
          id: category.id,
          name: category.name,
          description: category.description || undefined,
          url: category.url,
          published_articles: (category.published_questions ?? []).map(slimArticle),
          draft_articles: (category.draft_questions ?? []).map(slimArticle),
        };
      }),
  );

  server.registerTool(
    "create_category",
    {
      title: "Create category",
      description: "Create a knowledge base category, optionally nested under a parent.",
      inputSchema: {
        name: z.string().min(1),
        parentId: z.number().int().positive().optional().describe("Parent category ID for a subcategory"),
        description: z.string().optional(),
        accessibility,
      },
      annotations: WRITE,
    },
    async ({ name, parentId, description, accessibility }) =>
      run(() =>
        client.createCategory({
          name,
          parent_id: parentId,
          description,
          accessibility: accessibility ? ACCESS_CODE[accessibility] : undefined,
        }),
      ),
  );

  server.registerTool(
    "list_recent_activity",
    {
      title: "Recent activity",
      description: "Recent knowledge base activity (who created, edited or published what), newest first.",
      inputSchema: {
        ...paging,
        trackableType: z.string().optional().describe("e.g. Question (articles) or Category"),
        actionType: z.string().optional().describe("e.g. create, update, destroy"),
      },
      annotations: RO,
    },
    async ({ page, limit, trackableType, actionType }) =>
      run(() => client.listActivities({ page, limit, trackable_type: trackableType, action_type: actionType })),
  );

  server.registerTool(
    "get_account",
    {
      title: "Account settings",
      description: "Get the knowledge base account settings (name, subdomain, internal KB flag, contact email).",
      inputSchema: {},
      annotations: RO,
    },
    async () => run(() => client.accountSettings()),
  );

  return server;
}
