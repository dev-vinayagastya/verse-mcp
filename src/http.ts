import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { classifyKey, type Credentials } from "./config.js";
import { createVerseServer } from "./server.js";

export interface HttpHandlerOptions {
  baseUrl: string;
  /** Require an Authorization: Bearer <key> (or X-API-Key) header. Default true. */
  requireAuth?: boolean;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  /** Called once per JSON-RPC `tools/call` with the tool name (a short label), for adoption counters. Never receives arguments. */
  onToolCall?: (tool: string) => void;
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

/** Credentials from the request headers; the caller's own key, never stored or logged. */
export function credentialsFromRequest(req: IncomingMessage): Credentials {
  const auth = String(req.headers["authorization"] ?? "");
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  const c = classifyKey(m ? m[1] : "");
  const xk = String(req.headers["x-api-key"] ?? "").trim();
  if (xk) c.apiKey = xk;
  return c;
}

/**
 * A Node (req, res) handler for the Streamable HTTP transport, stateless:
 * every POST gets its own server bound to the caller's credentials, so one
 * deployment serves many users and nothing is kept between requests.
 * Mount at /mcp: `if (url.pathname === "/mcp") return handler(req, res)`.
 */
export function createHttpHandler(o: HttpHandlerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed; POST JSON-RPC to this endpoint." }, id: null }, { Allow: "POST" });
    }
    const creds = credentialsFromRequest(req);
    if ((o.requireAuth ?? true) && !creds.token && !creds.apiKey) {
      return send(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Send your Verse key as 'Authorization: Bearer <key>'." }, id: null }, { "WWW-Authenticate": 'Bearer realm="verse-mcp"' });
    }
    let parsed: unknown;
    try {
      const chunks: Buffer[] = [];
      let n = 0;
      for await (const c of req) {
        n += (c as Buffer).length;
        if (n > 4_194_304) return send(res, 413, { jsonrpc: "2.0", error: { code: -32600, message: "Request too large." }, id: null });
        chunks.push(c as Buffer);
      }
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error." }, id: null });
    }
    if (o.onToolCall) {
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
        const r = m as { method?: unknown; params?: { name?: unknown } };
        if (r?.method === "tools/call") {
          try { o.onToolCall(typeof r.params?.name === "string" ? r.params.name : "call"); } catch { /* counters never break a call */ }
        }
      }
    }
    const server = createVerseServer({ baseUrl: o.baseUrl, credentials: creds, allowLocalFiles: false, fetch: o.fetch, pollIntervalMs: o.pollIntervalMs });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch {
      if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error." }, id: null });
    }
  };
}
