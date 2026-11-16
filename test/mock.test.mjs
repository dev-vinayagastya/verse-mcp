// MCP server vs a scripted Verse origin, driven by the official MCP SDK
// client over BOTH transports (stdio child process and Streamable HTTP).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockVerse } from "./mock-verse.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
let mock, stdio, http, httpProc, noKey;
const SECRET_KEY = "a".repeat(64);
const dir = mkdtempSync(join(tmpdir(), "verse-mcp-"));
const glb = join(dir, "villa.glb");
writeFileSync(glb, Buffer.concat([Buffer.from("glTF"), Buffer.alloc(2048)]));
const big = join(dir, "big.glb");
writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 1)); // > one 8 MB part when resumable is forced
const text = (r) => r.content.map((c) => c.text).join("\n");

async function stdioClient(env) {
  const t = new StdioClientTransport({ command: "node", args: [cli], env: { PATH: process.env.PATH, ...env }, stderr: "pipe" });
  const c = new Client({ name: "t", version: "0" });
  await c.connect(t);
  return c;
}

before(async () => {
  mock = await startMockVerse();
  stdio = await stdioClient({ VERSE_BASE_URL: mock.url, VERSE_API_KEY: mock.TOKEN });
  noKey = await stdioClient({ VERSE_BASE_URL: mock.url });
  const port = 43871;
  httpProc = spawn("node", [cli, "--http", "--port", String(port)], { env: { PATH: process.env.PATH, VERSE_BASE_URL: mock.url }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  http = new Client({ name: "t", version: "0" });
  await http.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mock.TOKEN}` } } }));
  globalThis.__port = port;
});
after(async () => {
  await stdio?.close(); await noKey?.close(); await http?.close();
  httpProc?.kill(); await mock?.close();
});

test("lists the documented tools with schemas and descriptions", async () => {
  const { tools } = await stdio.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["create_share_link", "get_embed_code", "get_scene_status", "list_camera_paths", "list_scenes", "reset_auto_camera_path", "revoke_share_link", "set_camera_path", "upload_scene"]);
  for (const t of tools) {
    assert.ok(t.description.length > 40, t.name);
    assert.equal(t.inputSchema.type, "object");
  }
  assert.ok(!names.includes("generate_world"));
});

test("upload_scene: local file -> waits -> link, with progress notifications", async () => {
  const progress = [];
  const r = await stdio.callTool({ name: "upload_scene", arguments: { source: glb, name: "villa" } }, undefined, { onprogress: (p) => progress.push(p), timeout: 60000 });
  assert.ok(!r.isError, text(r));
  assert.match(r.structuredContent.link, /\/view\?vpk=ingest\/villa-\d+\.vpk$/);
  assert.equal(r.structuredContent.status, "done");
  assert.ok(progress.length >= 2, "progress notifications arrive");
  const up = mock.requests.find((q) => q.method === "POST" && q.path === "/v1/ingest");
  assert.equal(up.headers.authorization, `Bearer ${SECRET_KEY}`);
  assert.match(up.headers["x-verse-source"], /^verse-mcp\//);
  assert.ok(!JSON.stringify(r).includes(SECRET_KEY));
});

test("upload_scene: a 9 MB file goes through the resumable path", async () => {
  mock.requests.length = 0;
  const r = await stdio.callTool({ name: "upload_scene", arguments: { source: big, wait_seconds: 0, resumable: true } });
  assert.ok(!r.isError, text(r));
  assert.equal(r.structuredContent.status, "compiling");
  assert.equal(mock.requests.filter((q) => q.path === "/v1/ingest/begin").length, 1);
  assert.ok(mock.requests.some((q) => q.path.startsWith("/v1/ingest/commit/")));
});

test("upload_scene: public URL goes server-side; private URL is a plain sentence", async () => {
  const r = await stdio.callTool({ name: "upload_scene", arguments: { source: "https://cdn.example.com/a.glb", name: "web" } }, undefined, { timeout: 60000 });
  assert.ok(!r.isError, text(r));
  assert.equal(r.structuredContent.status, "done");
  const bad = await stdio.callTool({ name: "upload_scene", arguments: { source: "http://localhost/a.glb" } });
  assert.equal(bad.isError, true);
  assert.equal(text(bad).split("\n").length, 1);
  assert.match(text(bad), /private or local/);
});

test("upload_scene: failures and bad input are one plain sentence", async () => {
  const missing = await stdio.callTool({ name: "upload_scene", arguments: { source: join(dir, "nope.glb") } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /No file exists/);
  const failed = await stdio.callTool({ name: "upload_scene", arguments: { source: glb, name: "bad" } }, undefined, { timeout: 60000 });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /no meshes/);
  assert.equal(text(failed).split("\n").length, 1);
});

test("get_scene_status follows a build to done; accepts a link", async () => {
  const up = await stdio.callTool({ name: "upload_scene", arguments: { source: glb, name: "st", wait_seconds: 0 } });
  const id = up.structuredContent.scene;
  const a = await stdio.callTool({ name: "get_scene_status", arguments: { scene: id } });
  assert.equal(a.structuredContent.status, "compiling");
  await stdio.callTool({ name: "get_scene_status", arguments: { scene: id } });
  const c = await stdio.callTool({ name: "get_scene_status", arguments: { scene: `https://verse.ctruh.com/?vpk=ingest/${id}.vpk` } });
  assert.equal(c.structuredContent.status, "done");
});

test("list_scenes, create_share_link (private mints token), revoke, embed, paths", async () => {
  const ls = await stdio.callTool({ name: "list_scenes", arguments: { limit: 3 } });
  assert.ok(ls.structuredContent.scenes.length >= 1);
  const id = ls.structuredContent.scenes[0].id;

  const priv = await stdio.callTool({ name: "create_share_link", arguments: { scene: id, visibility: "private" } });
  assert.ok(!priv.isError, text(priv));
  assert.equal(priv.structuredContent.visibility, "private");
  assert.match(priv.structuredContent.link, /share=b{32}/);
  assert.equal(priv.structuredContent.shareId, "0ca2f454");

  const open = await stdio.callTool({ name: "create_share_link", arguments: { scene: id, visibility: "unlisted", autoplay_tour: true } });
  assert.match(open.structuredContent.link, /autoplay=path/);
  assert.ok(!open.structuredContent.link.includes("share="));

  const rv = await stdio.callTool({ name: "revoke_share_link", arguments: { scene: id, share_id: "0ca2f454" } });
  assert.equal(rv.structuredContent.revoked, "0ca2f454");

  const emb = await stdio.callTool({ name: "get_embed_code", arguments: { scene: id, aspect: "1:1" } });
  assert.match(emb.structuredContent.iframe, /<iframe/);

  const sp = await stdio.callTool({ name: "set_camera_path", arguments: { scene: id, name: "Tour", keys: [{ p: [0, 1.6, 0], f: [0, 0, -1] }, { p: [0, 1.6, -4], f: [1, 0, 0], hold: 1.5, label: "Living" }] } });
  assert.ok(!sp.isError, text(sp));
  assert.match(sp.structuredContent.tourLink, /autoplay=path&path=p1abc/);
  const lp = await stdio.callTool({ name: "list_camera_paths", arguments: { scene: id } });
  assert.equal(lp.structuredContent.paths.length, 1);
  const au = await stdio.callTool({ name: "reset_auto_camera_path", arguments: { scene: id } });
  assert.equal(au.structuredContent.kind, "drone");
  const bad = await stdio.callTool({ name: "set_camera_path", arguments: { scene: id, keys: [{ p: [0, 0, 0], f: [0, 0, 1] }] } }).catch((e) => e);
  assert.ok(bad.isError || bad instanceof Error, "one key is rejected by the schema");
});

test("a workspace API key (vk_) rides as Authorization: Bearer, like an account token", async () => {
  const key = "vk_" + "b".repeat(40);
  const c = await stdioClient({ VERSE_BASE_URL: mock.url, VERSE_API_KEY: key });
  try {
    const r = await c.callTool({ name: "list_scenes", arguments: {} });
    const q = [...mock.requests].reverse().find((x) => x.path === "/v1/account/scenes");
    assert.equal(q.headers.authorization, `Bearer ${key}`);
    assert.equal(q.headers["x-api-key"], undefined);
    assert.ok(!JSON.stringify(r).includes(key), "the key is never echoed");
  } finally {
    await c.close();
  }
});

test("without an account token owner tools say so in one sentence", async () => {
  const r = await noKey.callTool({ name: "list_scenes", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /VERSE_API_KEY/);
  assert.equal(text(r).split("\n").length, 1);
});

test("Streamable HTTP: same tools, caller's own key, no local files", async () => {
  const { tools } = await http.listTools();
  assert.equal(tools.length, 9);
  const ls = await http.callTool({ name: "list_scenes", arguments: {} });
  assert.ok(!ls.isError, text(ls));
  const local = await http.callTool({ name: "upload_scene", arguments: { source: glb } });
  assert.equal(local.isError, true);
  assert.match(text(local), /cannot read local files/);
  const url = await http.callTool({ name: "upload_scene", arguments: { source: "https://cdn.example.com/b.glb", name: "viahttp" } }, undefined, { timeout: 60000 });
  assert.ok(!url.isError, text(url));
});

test("Streamable HTTP: links carry the public origin the request arrived on, never the API's loopback", async () => {
  const port = globalThis.__port;
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${mock.TOKEN}`, "X-Forwarded-Proto": "https", "X-Forwarded-Host": "verse.example.com" } },
  }));
  try {
    const ls = await c.callTool({ name: "list_scenes", arguments: {} });
    const body = JSON.stringify(ls);
    assert.ok(body.includes("https://verse.example.com/"), "links use the forwarded origin");
    assert.ok(!body.includes(mock.url), "the API origin never leaks");
    const emb = await c.callTool({ name: "get_embed_code", arguments: { scene: ls.structuredContent.scenes[0].id } });
    const eb = JSON.stringify(emb);
    assert.ok(eb.includes("https://verse.example.com/embed"), "embed code uses the public origin");
    assert.ok(!eb.includes(mock.url));
  } finally {
    await c.close();
  }
});

test("Streamable HTTP: no key -> 401 with WWW-Authenticate; GET -> 405", async () => {
  const base = `http://127.0.0.1:${globalThis.__port}/mcp`;
  const r = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /Bearer/);
  assert.equal((await fetch(base)).status, 405);
});
