#!/usr/bin/env node
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION, baseUrlFromEnv, credentialsFromEnv } from "./config.js";
import { createVerseServer } from "./server.js";
import { createHttpHandler } from "./http.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const val = (n: string, d: string) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

if (flag("--help") || flag("-h")) {
  process.stdout.write(`verse-mcp ${VERSION}: MCP server for Verse (turn 3D files into shareable links)

  verse-mcp                       stdio server (Claude Desktop, Claude Code, Cursor, VS Code)
  verse-mcp --http [--port 8787] [--host 127.0.0.1] [--allow-anonymous]
                                  Streamable HTTP server at /mcp; callers send their own
                                  'Authorization: Bearer <key>'. Local file paths are disabled.

Environment:
  VERSE_API_KEY      your Verse API key (Account page, "API keys") or account token
  VERSE_BASE_URL     Verse origin (default https://verse.ctruh.com)
  VERSE_UPLOAD_KEY   X-API-Key for a self-hosted server in keyed mode (optional)
`);
  process.exit(0);
}
if (flag("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const baseUrl = baseUrlFromEnv();

if (flag("--http")) {
  const port = Number(val("--port", process.env.PORT || "8787"));
  const host = val("--host", "127.0.0.1");
  const handler = createHttpHandler({ baseUrl, requireAuth: !flag("--allow-anonymous") });
  const srv = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return void res.end("ok");
    }
    if (path === "/mcp") return void handler(req, res);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found; the MCP endpoint is /mcp"}');
  });
  srv.listen(port, host, () => process.stderr.write(`verse-mcp ${VERSION} listening on http://${host}:${port}/mcp (Verse origin ${baseUrl})\n`));
} else {
  const server = createVerseServer({ baseUrl, credentials: credentialsFromEnv(), allowLocalFiles: true });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`verse-mcp ${VERSION} ready on stdio (Verse origin ${baseUrl})\n`);
}
