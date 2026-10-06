#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HelpjuiceClient } from "./client.js";
import { createServer } from "./server.js";

async function main() {
  const apiKey = process.env.HELPJUICE_API_KEY ?? "";
  const account = process.env.HELPJUICE_ACCOUNT ?? "";
  const baseUrl = process.env.HELPJUICE_BASE_URL || undefined;
  if (!apiKey || (!account && !baseUrl)) {
    console.error(
      "helpjuice-mcp: set HELPJUICE_API_KEY and HELPJUICE_ACCOUNT (your subdomain, e.g. 'acme' for acme.helpjuice.com). Create a key under Settings > API Credentials.",
    );
    process.exit(1);
  }
  const client = new HelpjuiceClient({ apiKey, account, baseUrl });
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  console.error(`helpjuice-mcp running (${client.baseUrl})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
