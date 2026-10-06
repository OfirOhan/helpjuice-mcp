import { test } from "node:test";
import assert from "node:assert/strict";
import { HelpjuiceClient, baseUrlFor, htmlToText, toHtml, readableArticle, slimArticle } from "../dist/client.js";

function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, ...init });
    const { status = 200, body = {} } = (await responder(url, init)) ?? {};
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

test("derives the per-account API base from a subdomain or URL", () => {
  assert.equal(baseUrlFor("acme"), "https://acme.helpjuice.com/api/v3");
  assert.equal(baseUrlFor("https://acme.helpjuice.com/en_US"), "https://acme.helpjuice.com/api/v3");
  assert.throws(() => baseUrlFor(""), /subdomain is required/);
});

test("sends the raw API key in the Authorization header", async () => {
  const f = mockFetch(() => ({ body: { searches: [] } }));
  const c = new HelpjuiceClient({ apiKey: "hj_key", account: "acme", fetch: f });
  await c.search("reset password", 12);
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, "https://acme.helpjuice.com/api/v3/search");
  assert.equal(u.searchParams.get("query"), "reset password");
  assert.equal(u.searchParams.get("category_id"), "12");
  assert.equal(f.calls[0].headers.Authorization, "hj_key");
});

test("maps article filters to Helpjuice's filter[...] params", async () => {
  const f = mockFetch(() => ({ body: { articles: [], meta: {} } }));
  const c = new HelpjuiceClient({ apiKey: "k", account: "acme", fetch: f });
  await c.listArticles({ category_id: 3, is_published: false, accessibility: 0, language: "fr", limit: 50 });
  const q = new URL(f.calls[0].url).searchParams;
  assert.equal(q.get("filter[is_published]"), "false");
  assert.equal(q.get("filter[accessibility]"), "0");
  assert.equal(q.get("filter[language]"), "fr");
  assert.equal(q.get("category_id"), "3");
  assert.equal(q.get("limit"), "50");
});

test("wraps article and category writes in their resource keys", async () => {
  const f = mockFetch(() => ({ body: { article: { id: 9 } } }));
  const c = new HelpjuiceClient({ apiKey: "k", account: "acme", fetch: f });
  await c.createArticle({ name: "SSO", body: "<p>x</p>", published: false }, "en_US");
  assert.equal(f.calls[0].method, "POST");
  assert.ok(f.calls[0].url.includes("/articles?kb_language=en_US"));
  assert.deepEqual(JSON.parse(f.calls[0].body), { article: { name: "SSO", body: "<p>x</p>", published: false } });
  await c.updateArticle(9, { name: "SSO setup" });
  assert.equal(f.calls[1].method, "PUT");
  assert.ok(f.calls[1].url.endsWith("/articles/9"));
  await c.createCategory({ name: "Billing" });
  assert.deepEqual(JSON.parse(f.calls[2].body), { category: { name: "Billing" } });
  await c.deleteArticle(9);
  assert.equal(f.calls[3].method, "DELETE");
});

test("surfaces API errors with status and body", async () => {
  const f = mockFetch(() => ({ status: 401, body: { error: "Invalid API key" } }));
  const c = new HelpjuiceClient({ apiKey: "bad", account: "acme", fetch: f });
  await assert.rejects(() => c.accountSettings(), /Helpjuice API 401 .*Invalid API key/);
});

test("converts between HTML and readable text", () => {
  assert.equal(htmlToText("<h2>Steps</h2><ol><li>Open <b>Settings</b></li><li>Click&nbsp;Save</li></ol>"), "Steps\n\n- Open Settings\n- Click Save");
  assert.equal(toHtml("First line\nsecond\n\nNew <para>"), "<p>First line<br>second</p>\n<p>New &lt;para&gt;</p>");
  assert.equal(toHtml("<p>already html</p>"), "<p>already html</p>");
});

test("shapes articles for LLMs", () => {
  const a = { id: 1, name: "SSO", accessibility: 1, published: true, views: 40, updated_at: "2026-01-01", answer: { body: "<p>Hi</p>", body_txt: "", processed_body: "<p>Hi <b>there</b></p>" } };
  assert.equal(slimArticle(a).accessibility, "public");
  assert.equal(readableArticle(a).body, "Hi there");
  assert.equal(readableArticle(a, "html").body, "<p>Hi <b>there</b></p>");
});
