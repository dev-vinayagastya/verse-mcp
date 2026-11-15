// A scripted Verse origin speaking the documented routes and error contract
// (X-Verse-Error + {error}). Records every request so tests can assert on
// headers (and that keys never leak into tool output).
import { createServer } from "node:http";

export async function startMockVerse() {
  const requests = [];
  const jobs = new Map();
  const uploads = new Map();
  const vis = new Map();
  const paths = new Map();
  let n = 1;
  const TOKEN = "a".repeat(64);
  const json = (res, status, body) => {
    const h = { "Content-Type": "application/json" };
    if (status >= 400) h["X-Verse-Error"] = "1";
    res.writeHead(status, h);
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://mock");
    const p = url.pathname;
    requests.push({ method: req.method, path: p, headers: req.headers, bytes: body.length });
    const owner = req.headers.authorization === `Bearer ${TOKEN}`;
    const mk = (name) => {
      const id = `${name || "mock"}-${String(n++).padStart(12, "0")}`;
      jobs.set(id, { polls: 0, fail: name === "bad" });
      return id;
    };
    if (req.method === "POST" && p === "/v1/ingest") return json(res, 202, { job: mk(req.headers["x-verse-name"]) });
    if (req.method === "POST" && p === "/v1/ingest/url") {
      const b = JSON.parse(body.toString() || "{}");
      if (/localhost|127\./.test(b.url)) return json(res, 400, { error: "that address is private", errorInfo: { code: "url_blocked", message: "That address is private or local, so the server will not fetch it.", fix: "Use a public URL." } });
      return json(res, 202, { job: mk(b.name), sizeBytes: 3145728, source: "cdn.example.com" });
    }
    if (req.method === "POST" && p === "/v1/ingest/begin") {
      const b = JSON.parse(body.toString());
      const id = `up${uploads.size + 1}`;
      uploads.set(id, { size: b.size, received: 0, name: b.name });
      return json(res, 200, { uploadId: id, received: 0, size: b.size });
    }
    let m;
    if (req.method === "PUT" && (m = /^\/v1\/ingest\/part\/(\w+)$/.exec(p))) {
      const u = uploads.get(m[1]);
      u.received += body.length;
      return json(res, 200, { uploadId: m[1], received: u.received, size: u.size });
    }
    if (req.method === "POST" && (m = /^\/v1\/ingest\/commit\/(\w+)$/.exec(p))) return json(res, 202, { job: mk(uploads.get(m[1]).name) });
    if (req.method === "GET" && (m = /^\/v1\/ingest\/([\w-]+)$/.exec(p))) {
      const j = jobs.get(m[1]);
      if (!j) return json(res, 404, { error: "unknown job" });
      const k = j.polls++;
      if (j.fail) return json(res, 200, k < 1 ? { status: "compiling", stage: "preparing", progress: 0 } : { status: "error", error: "The file has no meshes with triangles.", errorInfo: { code: "no_meshes", message: "The file has no meshes with triangles; nothing to show.", fix: "Export with Mesh ticked.", retryable: false } });
      if (k < 2) return json(res, 200, { status: "compiling", stage: "textures", progress: 0.2 + k * 0.3, etaText: "A few seconds left" });
      return json(res, 200, { status: "done", url: `http://${req.headers.host}/?vpk=ingest/${m[1]}.vpk`, vpkUrl: `http://${req.headers.host}/ingest/${m[1]}.vpk`, stats: { mode: "streamed" } });
    }
    if (p.startsWith("/v1/account") || p.startsWith("/v1/scenes")) {
      if (!owner) return json(res, 401, { error: "sign in with your account token" });
      if (p === "/v1/account/scenes") {
        const scenes = [...jobs.keys()].map((id) => ({ id, kind: "vpk", path: "streamed", url: `http://${req.headers.host}/?vpk=ingest/${id}.vpk`, fileUrl: "", visibility: vis.get(id) ?? "unlisted", sizeBytes: 5 * 1048576, created: 1790833827960, stats: { opens: 2, uniqueSessions: 1, totalMinutes: 1 }, reviews: { open: 0, total: 0 } }));
        return json(res, 200, { accountId: "acct-1", scenes: scenes.reverse() });
      }
      if (req.method === "PATCH" && (m = /^\/v1\/scenes\/([\w-]+)$/.exec(p))) {
        if (!jobs.has(m[1])) return json(res, 404, { error: "not found" });
        const v = JSON.parse(body.toString()).visibility;
        vis.set(m[1], v);
        return json(res, 200, { id: m[1], visibility: v });
      }
      if (req.method === "POST" && (m = /^\/v1\/scenes\/([\w-]+)\/share$/.exec(p))) return json(res, 200, { id: "0ca2f454", suffix: "629b", created: 1, shareToken: "b".repeat(32) });
      if (req.method === "GET" && (m = /^\/v1\/scenes\/([\w-]+)\/share$/.exec(p))) return json(res, 200, { scene: m[1], shares: [{ id: "0ca2f454", suffix: "629b", created: 1 }] });
      if (req.method === "DELETE" && (m = /^\/v1\/scenes\/([\w-]+)\/share\/(\w+)$/.exec(p))) return json(res, 200, { revoked: m[2] });
      if ((m = /^\/v1\/scenes\/([\w-]+)\/paths$/.exec(p))) {
        const list = paths.get(m[1]) ?? [];
        if (req.method === "GET") return json(res, 200, { scene: m[1], default: list[0]?.id ?? null, paths: list.map((x) => ({ id: x.id, name: x.name, mode: x.mode, keys: x.keys.length })), canEdit: true });
        if (req.method === "POST") {
          const b = JSON.parse(body.toString());
          const rec = { id: `p${list.length + 1}abc`, ...b };
          paths.set(m[1], [...list, rec]);
          return json(res, 200, { scene: m[1], id: rec.id, default: list.length === 0, keys: b.keys.length });
        }
        if (req.method === "PUT") return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && (m = /^\/v1\/scenes\/([\w-]+)\/paths\/auto$/.exec(p))) return json(res, 200, { scene: m[1], default: true, id: "pauto", name: "Fly-through", mode: "fly", kind: "drone", auto: true, keys: [1, 2, 3] });
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, TOKEN, close: () => new Promise((r) => server.close(r)) };
}
