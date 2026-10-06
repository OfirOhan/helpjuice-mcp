// End-to-end: start the real MCP server over stdio against a local fake Helpjuice API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function fakeHelpjuice() {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader("Content-Type", "application/json");
      const path = req.url.split("?")[0];
      const send = (x) => res.end(JSON.stringify(x));
      if (path === "/api/v3/search")
        return send({ searches: [{ id: 42, name: "Set up SSO", slug: "set-up-sso", answer_sample: "<p>Go to <b>Settings</b></p>", categories: [{ id: 3, name: "Admin" }], is_published: true }] });
      if (path === "/api/v3/articles/42" && req.method === "GET")
        return send({ article: { id: 42, name: "Set up SSO", accessibility: 1, published: true, answer: { body: "<p>raw</p>", processed_body: "<h2>Steps</h2><p>Go to <b>Settings</b> &amp; enable SAML.</p>" } } });
      if (path === "/api/v3/articles" && req.method === "GET")
        return send({
          articles: [
            { id: 1, name: "Old pricing", published: true, updated_at: "2025-01-10T00:00:00Z" },
            { id: 2, name: "Older FAQ", published: true, updated_at: "2024-06-01T00:00:00Z" },
            { id: 3, name: "Fresh", published: true, updated_at: "2026-10-01T00:00:00Z" },
          ],
          meta: { current: 1, total_pages: 1, total_count: 3 },
        });
      if (path === "/api/v3/articles" && req.method === "POST") return send({ article: { id: 99, name: JSON.parse(body).article.name, published: false } });
      res.statusCode = 404;
      send({ error: "Not found" });
    });
  });
  return { srv, seen };
}

function rpcClient(child) {
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let id = 0;
  return {
    request(method, params) {
      const myId = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      return new Promise((resolve, reject) => {
        pending.set(myId, resolve);
        setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

test("MCP handshake, tool listing, search, read, audit and draft an article", async () => {
  const { srv, seen } = fakeHelpjuice();
  srv.listen(0);
  await once(srv, "listening");
  const port = srv.address().port;

  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, HELPJUICE_API_KEY: "hj_test", HELPJUICE_ACCOUNT: "", HELPJUICE_BASE_URL: `http://127.0.0.1:${port}/api/v3` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const rpc = rpcClient(child);
    const init = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "helpjuice-mcp");
    rpc.notify("notifications/initialized", {});

    const list = await rpc.request("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "create_article",
      "create_category",
      "delete_article",
      "find_stale_articles",
      "get_account",
      "get_article",
      "get_category",
      "list_articles",
      "list_categories",
      "list_recent_activity",
      "search_knowledge_base",
      "update_article",
    ]);
    assert.equal(list.result.tools.find((t) => t.name === "delete_article").annotations.destructiveHint, true);

    const found = await rpc.request("tools/call", { name: "search_knowledge_base", arguments: { query: "sso" } });
    const hits = JSON.parse(found.result.content[0].text);
    assert.equal(hits[0].id, 42);
    assert.equal(hits[0].sample, "Go to Settings");
    assert.deepEqual(hits[0].categories, ["Admin"]);

    const read = await rpc.request("tools/call", { name: "get_article", arguments: { articleId: 42 } });
    const art = JSON.parse(read.result.content[0].text);
    assert.equal(art.body, "Steps\nGo to Settings & enable SAML.");
    assert.equal(art.accessibility, "public");
    const getReq = seen.find((s) => s.url.startsWith("/api/v3/articles/42"));
    assert.equal(new URL(getReq.url, "http://x").searchParams.get("processed"), "true");

    const stale = await rpc.request("tools/call", { name: "find_stale_articles", arguments: { days: 365 } });
    const s = JSON.parse(stale.result.content[0].text);
    assert.deepEqual(s.articles.map((a) => a.id), [2, 1]);
    const listReq = new URL(seen.find((x) => x.method === "GET" && x.url.startsWith("/api/v3/articles?")).url, "http://x").searchParams;
    assert.equal(listReq.get("filter[is_published]"), "true");
    assert.ok(listReq.get("updated_upto"));

    const draft = await rpc.request("tools/call", {
      name: "create_article",
      arguments: { name: "Rotate API keys", body: "Open Settings.\n\nClick Rotate.", categoryIds: [3] },
    });
    assert.equal(JSON.parse(draft.result.content[0].text).id, 99);
    const sent = JSON.parse(seen.find((x) => x.method === "POST").body).article;
    assert.equal(sent.published, false);
    assert.equal(sent.body, "<p>Open Settings.</p>\n<p>Click Rotate.</p>");
    assert.deepEqual(sent.category_ids, [3]);
    assert.ok(seen.every((x) => x.auth === "hj_test"));

    const bad = await rpc.request("tools/call", { name: "get_category", arguments: { categoryId: 7 } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /Helpjuice API 404/);
  } finally {
    child.kill();
    srv.close();
  }
});
