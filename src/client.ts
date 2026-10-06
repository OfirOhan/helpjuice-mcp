/**
 * Minimal typed client for the Helpjuice API v3.
 * Docs: https://help.helpjuice.com/en_US/api-v3/using-api-v3
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HelpjuiceClientOptions {
  apiKey: string;
  /** Your account subdomain, e.g. "acme" for acme.helpjuice.com. Ignored when baseUrl is set. */
  account?: string;
  /** Full API base, e.g. https://acme.helpjuice.com/api/v3 */
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface PageQuery {
  page?: number;
  limit?: number;
}

export interface ArticleQuery extends PageQuery {
  category_id?: number;
  created_since?: string;
  updated_since?: string;
  updated_upto?: string;
  is_published?: boolean;
  accessibility?: 0 | 1 | 2;
  language?: string;
}

export interface ArticleInput {
  name?: string;
  description?: string;
  codename?: string;
  body?: string;
  published?: boolean;
  category_ids?: number[];
  visibility_id?: number;
}

export interface CategoryInput {
  name: string;
  parent_id?: number;
  description?: string;
  codename?: string;
  accessibility?: number;
}

export type Json = Record<string, any>;

export class HelpjuiceApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    path: string,
  ) {
    super(`Helpjuice API ${status} on ${path}: ${body.slice(0, 500)}`);
    this.name = "HelpjuiceApiError";
  }
}

export function baseUrlFor(account: string) {
  const sub = account
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.helpjuice\.com.*$/, "")
    .replace(/\/.*$/, "");
  if (!sub) throw new Error("A Helpjuice account subdomain is required (set HELPJUICE_ACCOUNT, e.g. 'acme').");
  return `https://${sub}.helpjuice.com/api/v3`;
}

const enc = encodeURIComponent;

export class HelpjuiceClient {
  private apiKey: string;
  readonly baseUrl: string;
  private fetchImpl: FetchLike;

  constructor(opts: HelpjuiceClientOptions) {
    if (!opts.apiKey) throw new Error("A Helpjuice API key is required (set HELPJUICE_API_KEY).");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? baseUrlFor(opts.account ?? "")).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(method: string, path: string, query?: object, body?: unknown): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Authorization: this.apiKey, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new HelpjuiceApiError(res.status, text, path);
    if (!text.trim()) return { ok: true } as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { message: text } as T;
    }
  }

  search(query: string, categoryId?: number) {
    return this.request<{ searches?: Json[] }>("GET", "/search", { query, category_id: categoryId });
  }

  listArticles(q: ArticleQuery = {}) {
    const { is_published, accessibility, language, ...rest } = q;
    return this.request<{ articles: Json[]; meta?: Json }>("GET", "/articles", {
      ...rest,
      "filter[is_published]": is_published,
      "filter[accessibility]": accessibility,
      "filter[language]": language,
    });
  }

  getArticle(id: number, opts: { processed?: boolean; kb_language?: string } = {}) {
    return this.request<{ article: Json }>("GET", `/articles/${enc(String(id))}`, opts);
  }

  createArticle(article: ArticleInput, kbLanguage?: string) {
    return this.request<{ article: Json }>("POST", "/articles", { kb_language: kbLanguage }, { article });
  }

  updateArticle(id: number, article: ArticleInput) {
    return this.request<{ article: Json }>("PUT", `/articles/${enc(String(id))}`, undefined, { article });
  }

  deleteArticle(id: number) {
    return this.request<Json>("DELETE", `/articles/${enc(String(id))}`);
  }

  listCategories(languageCode?: string) {
    return this.request<{ categories: Json[]; meta?: Json }>("GET", "/categories", { language_code: languageCode });
  }

  getCategory(id: number) {
    return this.request<{ category: Json }>("GET", `/categories/${enc(String(id))}`);
  }

  createCategory(category: CategoryInput) {
    return this.request<{ category: Json }>("POST", "/categories", undefined, { category });
  }

  listActivities(q: PageQuery & { trackable_type?: string; action_type?: string; older_than?: string } = {}) {
    return this.request<{ activities: Json[]; meta?: Json }>("GET", "/activities", { reverse_chronologically: true, ...q });
  }

  accountSettings() {
    return this.request<{ account: Json }>("GET", "/settings/account");
  }
}

/** Strip HTML to readable plain text for LLM consumption. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/(p|div|h[1-6]|tr|ul|ol|table|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Accept plain text or HTML; plain text becomes simple paragraphs. */
export function toHtml(body: string): string {
  if (/<\/?(p|div|br|h[1-6]|ul|ol|li|a|b|strong|em|i|u|img|table|pre|code|span|blockquote)\b[^>]*>/i.test(body)) return body;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

const ACCESS: Record<string, string> = { "0": "internal", "1": "public", "2": "private" };

/** Compact article shape for lists: enough to pick one, small enough to fit many. */
export function slimArticle(a: Json) {
  return {
    id: a.id,
    name: a.name,
    description: a.description || undefined,
    url: a.url,
    published: a.published ?? a.is_published,
    accessibility: a.accessibility !== undefined ? ACCESS[String(a.accessibility)] ?? a.accessibility : undefined,
    views: a.views,
    updated_at: a.updated_at,
  };
}

/** Full article with a readable body. */
export function readableArticle(a: Json, format: "text" | "html" = "text") {
  const answer = a.answer ?? {};
  const html: string = answer.processed_body ?? answer.body ?? "";
  return {
    ...slimArticle(a),
    codename: a.codename,
    created_at: a.created_at,
    categories: Array.isArray(a.categories) ? a.categories.map((c: Json) => ({ id: c.id, name: c.name })) : undefined,
    body: format === "html" ? html : answer.body_txt?.trim() || htmlToText(html),
  };
}
