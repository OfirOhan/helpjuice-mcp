# Helpjuice MCP Server

[![CI](https://github.com/OfirOhan/helpjuice-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/OfirOhan/helpjuice-mcp/actions/workflows/ci.yml)
![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A [Model Context Protocol](https://modelcontextprotocol.io) server for **[Helpjuice](https://helpjuice.com)**. It lets Claude, Cursor, ChatGPT and other AI agents search and read your knowledge base, draft and update articles, and audit stale content.

> **Unofficial.** This is a community project and is not affiliated with Helpjuice. It was built from Helpjuice's public API v3 docs.

## What you can ask your agent

- "Search our knowledge base for how SSO is set up and answer this customer's question, with a link to the article."
- "Which published articles in **Billing** haven't been touched in a year? Give me a table, oldest first."
- "Turn this Slack thread into a draft help article in the **Integrations** category. Don't publish it."
- "Our pricing page changed. Find every article that mentions the old 'Starter' plan and propose edits."
- "What did the team publish or edit this week?"

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `search_knowledge_base` | Full-text search with clean text samples | No |
| `get_article` | Read an article as **clean plain text** (internal blocks expanded) or HTML for editing | No |
| `list_articles` | Filter by category, published/draft, visibility, dates, language | No |
| `find_stale_articles` | Published articles not updated in N days, oldest first | No |
| `list_categories` / `get_category` | Category tree with article counts, or one category's articles | No |
| `list_recent_activity` | Who created, edited or published what | No |
| `get_account` | Account settings | No |
| `create_article` | New article, **saved as a draft by default**; accepts HTML or plain text | Yes |
| `update_article` | Change only the fields you pass | Yes |
| `create_category` | New category or subcategory | Yes |
| `delete_article` | Delete an article | **Destructive** |

Design notes:

- Article bodies come back as readable text instead of raw HTML, which keeps answers grounded and saves tokens. Ask for `format: "html"` when editing.
- New articles are **unpublished drafts** unless you explicitly set `published: true`, so an agent can't put content in front of customers by accident.
- Lists return compact rows (id, title, visibility, views, last updated) so an agent can scan hundreds of articles in one call.
- All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`), so clients can ask before writing.

## Setup

1. In Helpjuice, go to **Settings → API Credentials**, enable token-based API access and copy your API key.
2. Build it:

```bash
git clone https://github.com/OfirOhan/helpjuice-mcp.git
cd helpjuice-mcp && npm install && npm run build
```

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "helpjuice": {
      "command": "node",
      "args": ["/absolute/path/to/helpjuice-mcp/dist/index.js"],
      "env": { "HELPJUICE_ACCOUNT": "yourcompany", "HELPJUICE_API_KEY": "your-api-key" }
    }
  }
}
```

### Claude Code / Cursor / other MCP clients

```bash
claude mcp add helpjuice -e HELPJUICE_ACCOUNT=yourcompany -e HELPJUICE_API_KEY=your-api-key -- node /path/to/helpjuice-mcp/dist/index.js
```

For Cursor and other clients, use the same command with the variables below in the environment.

| Variable | Default | Notes |
|---|---|---|
| `HELPJUICE_API_KEY` | (required) | Your Helpjuice API key |
| `HELPJUICE_ACCOUNT` | (required) | Your subdomain, e.g. `yourcompany` for yourcompany.helpjuice.com |
| `HELPJUICE_BASE_URL` | `https://<account>.helpjuice.com/api/v3` | Override for testing |

## Development

```bash
npm install
npm test   # builds, runs unit tests and an end-to-end MCP stdio test against a fake Helpjuice API
```

The tests run on Node 20, 22 and 24 in CI.

## Author

Built by [Ofir Ohana](https://github.com/OfirOhan), an AI agents engineer. Issues and PRs are welcome.

## License

MIT
