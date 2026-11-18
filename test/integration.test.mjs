// The MCP server against a REAL serve.mjs started on a free 43xx port (and
// killed by PID, only ours). Without target/release/verse-compile the server
// cannot finish a build, so the "done" path is covered by mock.test.mjs;
// here we prove the wire contract: real upload routes, real error contract,
// account-gated tools, real status record.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
const playground = resolve(here, "../../../web/playground");
const PORT = Number(process.env.QA_PORT) || 43917;
const BASE = `http://127.0.0.1:${PORT}`;
let server, client, anon, token;
const text = (r) => r.content.map((c) => c.text).join("\n");
const dir = mkdtempSync(join(tmpdir(), "verse-mcp-it-"));

// A tiny valid GLB (one triangle).
function tinyGlb() {
  const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }], bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }] };
  let j = Buffer.from(JSON.stringify(json)); j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const bin = Buffer.alloc(36); [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const h = Buffer.alloc(12); h.write("glTF"); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + j.length + 8 + 36, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(j.length); c1.write("JSON", 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(36); c2.write("BIN\0", 4);
  return Buffer.concat([h, c1, j, c2, bin]);
}
const glb = join(dir, "tri.glb");
writeFileSync(glb, tinyGlb());

async function mcp(env) {
  const c = new Client({ name: "it", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: [cli], env: { PATH: process.env.PATH, VERSE_BASE_URL: BASE, ...env }, stderr: "pipe" }));
  return c;
}

before(async () => {
  server = spawn("node", [join(playground, "serve.mjs")], { cwd: playground, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/v1/limits`)).ok) break; } catch {}
    if (i > 150) throw new Error(`serve.mjs did not come up on :${PORT}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const acct = await (await fetch(`${BASE}/v1/account`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "mcp-it" }) })).json();
  token = acct.token;
  client = await mcp({ VERSE_API_KEY: token });
  anon = await mcp({});
});
after(async () => {
  await client?.close(); await anon?.close();
  server?.kill(); // our own child only
  try { for (const f of readdirSync(join(playground, "ingest"))) if (/^mcpit-/.test(f)) unlinkSync(join(playground, "ingest", f)); } catch {}
});

test("tools/list over stdio", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 9);
});

test("upload_scene uploads to the real server and reports the build outcome in one sentence or a link", async () => {
  const r = await client.callTool({ name: "upload_scene", arguments: { source: glb, name: "mcpit", wait_seconds: 120 } }, undefined, { timeout: 150000 });
  const t = text(r);
  if (r.isError) {
    assert.equal(t.split("\n").length, 1, t);   // e.g. no compiler on this box
  } else {
    assert.match(r.structuredContent.link, /mcpit-/);
  }
  assert.ok(!t.includes(token));
});

test("get_scene_status reads a real job record; unknown job is a sentence", async () => {
  const up = await client.callTool({ name: "upload_scene", arguments: { source: glb, name: "mcpit", wait_seconds: 0 } });
  assert.ok(!up.isError, text(up));
  const st = await client.callTool({ name: "get_scene_status", arguments: { scene: up.structuredContent.scene } });
  assert.ok(["compiling", "done", "error"].includes(st.structuredContent.status));
  const unk = await client.callTool({ name: "get_scene_status", arguments: { scene: "nope-000000000000" } });
  assert.equal(unk.isError, true);
  assert.equal(text(unk).split("\n").length, 1);
});

test("list_scenes works with the account token and is refused without one", async () => {
  const ok = await client.callTool({ name: "list_scenes", arguments: {} });
  assert.ok(!ok.isError, text(ok));
  assert.ok(Array.isArray(ok.structuredContent.scenes));
  const no = await anon.callTool({ name: "list_scenes", arguments: {} });
  assert.equal(no.isError, true);
  assert.match(text(no), /VERSE_API_KEY/);
});

test("upload from a private URL is refused by the real server", async () => {
  const r = await client.callTool({ name: "upload_scene", arguments: { source: "http://127.0.0.1/a.glb" } });
  assert.equal(r.isError, true);
  assert.equal(text(r).split("\n").length, 1);
});
