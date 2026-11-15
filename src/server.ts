import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { JobRecord, SceneSummary, VerseClient } from "@ctruhtech/verse-sdk";
import { VerseError } from "@ctruhtech/verse-sdk";
import { VERSION, makeClient, type Credentials } from "./config.js";
import { ToolError, plainError, sceneIdOf } from "./util.js";

export interface ServerOptions {
  baseUrl: string;
  credentials: Credentials;
  /** stdio: true (the agent runs on the user's machine). HTTP: false (a remote server must not read its own disk). */
  allowLocalFiles: boolean;
  fetch?: typeof fetch;
  /** Poll interval override (tests). */
  pollIntervalMs?: number;
}

const INSTRUCTIONS =
  "Verse turns 3D files (GLB, glTF, FBX, OBJ, IFC, USD/USDZ, PLY, SPLAT, SPZ-class captures, point clouds) into a shareable link that opens in any browser, with no app and no plugin. " +
  "Use upload_scene with a local file path or a public URL, then share the returned link or call get_embed_code for an iframe. " +
  "Owner actions (list_scenes, visibility, private share links, camera paths) need the user's Verse account token in VERSE_API_KEY. " +
  "Builds can take a minute or more for large files; if upload_scene returns before the build is done, poll get_scene_status.";

const sceneArg = z.string().min(3).max(600).describe("Scene id (e.g. palm-villa-0a1b2c3d4e5f), the job id returned by upload_scene, or a Verse share link.");

const KINDS = ["splat", "cloud", "ifc", "usd", "fbx", "obj"] as const;

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (text: string, data?: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}) });

export function createVerseServer(opts: ServerOptions): McpServer {
  const client: VerseClient = makeClient(opts.baseUrl, opts.credentials, opts.fetch);
  if (opts.pollIntervalMs) (client as unknown as { pollIntervalMs: number }).pollIntervalMs = opts.pollIntervalMs;
  const hasAccount = !!opts.credentials.token;
  const server = new McpServer({ name: "verse", version: VERSION }, { instructions: INSTRUCTIONS });

  const needAccount = (what: string) => {
    if (!hasAccount) throw new ToolError(`${what} needs a Verse key; set VERSE_API_KEY to an API key from your Account page (${opts.baseUrl}/account, "API keys") or your account token.`);
  };

  /** Wrap a handler: any failure becomes one plain sentence with isError. */
  const guard =
    <A, X>(fn: (args: A, extra: X) => Promise<ToolResult>) =>
    async (args: A, extra: X): Promise<ToolResult> => {
      try {
        return await fn(args, extra);
      } catch (e) {
        return { content: [{ type: "text", text: plainError(e, hasAccount) }], isError: true };
      }
    };

  /** Best record for a scene: the live job record (2 h), else the owner's scene list entry, else just the id. */
  async function resolveScene(id: string): Promise<JobRecord | SceneSummary | string> {
    try {
      const rec = await client.job(id);
      if (rec.status === "done") return rec;
    } catch {
      /* fall through */
    }
    if (hasAccount) {
      try {
        return await client.scenes.get(id);
      } catch {
        /* fall through */
      }
    }
    return id;
  }

  function progressNotifier(extra: any) {
    const token = extra?._meta?.progressToken;
    let last = -1;
    return async (progress: number, total: number, message: string) => {
      if (token === undefined || token === null) return;
      if (progress === last) return;
      last = progress;
      try {
        await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, total, message } });
      } catch {
        /* the client went away; the upload carries on */
      }
    };
  }

  const linkOf = (rec: JobRecord | SceneSummary | string): string => client.shareLink(rec as any);

  // ── upload_scene ──────────────────────────────────────────────────────
  server.registerTool(
    "upload_scene",
    {
      title: "Upload a 3D file and get a Verse link",
      description:
        "Upload a 3D file and turn it into a shareable Verse link that opens in any browser. `source` is a local file path (stdio only) or a public http(s) URL the Verse server will fetch itself " +
        "(Dropbox needs dl=1, Google Drive needs 'anyone with the link', S3/R2/GCS need a presigned URL). Accepts GLB, glTF, FBX, OBJ, IFC, USD/USDZ, PLY, SPLAT and point clouds (LAS/LAZ/E57). " +
        "Large local files upload in resumable parts and survive dropped connections; progress is reported as notifications. " +
        "By default the call waits for the build to finish and returns the link; if the build outlasts `wait_seconds` it returns the job id so you can poll get_scene_status. " +
        "Result: `link` (open in a browser), `scene` (id), `status`.",
      inputSchema: {
        source: z.string().min(1).max(4096).describe("Local file path (e.g. ~/Models/villa.glb) or a public http(s) URL to a 3D file."),
        name: z.string().regex(/^[a-z0-9_-]{1,48}$/).optional().describe("Optional slug used as the scene id prefix, lowercase letters, digits, - and _."),
        kind: z.enum(KINDS).optional().describe("Force the file kind when the extension is ambiguous (e.g. 'splat' for a Gaussian-splat .ply). Normally detected from the bytes."),
        as: z.enum(["product", "interior", "building", "exterior"]).optional().describe("Say what the file is: a 'product' (a single object) or a walkable 'interior'/'building'/'exterior'. Local uploads only; otherwise detected."),
        path: z.enum(["fidelity", "streamed"]).optional().describe("'fidelity' publishes the model as-is (best for single products); 'streamed' builds a streamed scene (best for big walkable scenes). Normally decided automatically."),
        bake: z.enum(["preview", "final"]).optional().describe("Bake lighting on the server before building (for live-lit GLBs). Slower."),
        visibility: z.enum(["public", "unlisted", "private"]).optional().describe("Set after the build finishes. Needs an account token. 'private' scenes only open with a share link from create_share_link."),
        resumable: z.boolean().optional().describe("Force resumable multi-part upload (default: automatic above 100 MB). Use on flaky connections."),
        wait_seconds: z.number().int().min(0).max(3000).default(600).describe("How long to wait for the build before returning the job id (0 = return right after upload)."),
      },
      annotations: { title: "Upload a 3D file", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (a: any, extra: any) => {
      const notify = progressNotifier(extra);
      const wait = a.wait_seconds ?? 600;
      const src = String(a.source).trim();
      const isUrl = /^https?:\/\//i.test(src);
      let job: string;
      let origin: string;

      if (isUrl) {
        await notify(0, 1, "Asking Verse to fetch the file");
        const r = await client.uploadFromUrl(src, { name: a.name, kind: a.kind, bake: a.bake, path: a.path, signal: extra?.signal });
        job = r.job;
        origin = `${r.source} (${(r.sizeBytes / 1048576).toFixed(1)} MB)`;
      } else {
        if (!opts.allowLocalFiles) throw new ToolError("This remote server cannot read local files; pass a public http(s) URL as the source, or run the stdio server (npx @ctruhtech/verse-mcp) on your machine.");
        const p = resolve(src.startsWith("file://") ? new URL(src).pathname : src.replace(/^~(?=$|\/)/, homedir()));
        let st;
        try {
          st = await stat(p);
        } catch {
          throw new ToolError(`No file exists at ${p}.`);
        }
        if (!st.isFile()) throw new ToolError(`${p} is not a file; zip a folder (e.g. an OBJ with textures) first.`);
        if (st.size === 0) throw new ToolError(`${basename(p)} is empty.`);
        const blob = await openAsBlob(p); // file-backed, sliced lazily: a 5 GB file is never held in memory
        origin = `${basename(p)} (${(st.size / 1048576).toFixed(1)} MB)`;
        const r = await client.upload(blob, {
          name: a.name,
          kind: a.kind,
          bake: a.bake,
          path: a.path,
          resumable: a.resumable,
          signal: extra?.signal,
          headers: a.as ? { "X-Verse-As": a.as } : undefined,
          onProgress: (pr) => void notify(pr.fraction * 0.5, 1, `Uploading ${origin}: ${Math.round(pr.fraction * 100)}%`),
        });
        job = r.job;
      }

      await notify(0.5, 1, "Uploaded; Verse is building the scene");
      if (wait === 0) return ok(`Uploaded ${origin}. The build is running; check it with get_scene_status (scene "${job}").`, { scene: job, status: "compiling" });

      let rec: JobRecord;
      try {
        rec = await client.waitForJob(job, {
          timeoutMs: wait * 1000,
          signal: extra?.signal,
          onProgress: (r) => void notify(0.5 + 0.5 * (r.progress ?? 0), 1, `Building: ${r.stage ?? r.status}${r.etaText ? `, ${r.etaText}` : ""}`),
        });
      } catch (e) {
        if (e instanceof VerseError && e.code === "timeout") {
          return ok(`Uploaded ${origin}. The build is still running after ${wait}s; check it with get_scene_status (scene "${job}").`, { scene: job, status: "compiling" });
        }
        throw e;
      }

      let visibility: string | undefined;
      if (a.visibility) {
        needAccount("Setting visibility");
        visibility = (await client.scenes.setVisibility(job, a.visibility)).visibility;
      }
      const link = linkOf(rec);
      const note = visibility === "private" ? " The scene is private: call create_share_link to get a link that opens it." : "";
      return ok(`Done. Open the scene: ${link}${note}`, {
        scene: job,
        status: "done",
        link,
        kind: rec.path ?? rec.stats?.mode ?? "streamed",
        ...(visibility ? { visibility } : {}),
        ...(rec.arUrl ? { arUrl: rec.arUrl } : {}),
        ...(rec.fixes ? { fixes: rec.fixes } : {}),
      });
    }),
  );

  // ── get_scene_status ──────────────────────────────────────────────────
  server.registerTool(
    "get_scene_status",
    {
      title: "Check a scene's build status",
      description:
        "Check whether an uploaded scene has finished building. Returns `status` (compiling | done | error), the stage, progress 0..1, an ETA while building, and the `link` once done. " +
        "Job records are kept for 2 hours after upload; older scenes are looked up in your account (needs VERSE_API_KEY).",
      inputSchema: { scene: sceneArg },
      annotations: { title: "Scene build status", readOnlyHint: true, openWorldHint: true },
    },
    guard(async (a: any) => {
      const id = sceneIdOf(a.scene);
      let rec: JobRecord | null = null;
      try {
        rec = await client.job(id);
      } catch (e) {
        if (!(e instanceof VerseError && e.code === "unknown_job")) throw e;
      }
      if (rec) {
        if (rec.status === "done") {
          const link = linkOf(rec);
          return ok(`Done. Open the scene: ${link}`, { scene: id, status: "done", link, ...(rec.arUrl ? { arUrl: rec.arUrl } : {}) });
        }
        if (rec.status === "error") {
          const msg = rec.errorInfo?.message || rec.error || "The build failed.";
          return ok(`The build failed: ${msg}${rec.errorInfo?.fix ? ` ${rec.errorInfo.fix}` : ""}`, { scene: id, status: "error", error: rec.errorInfo?.code ?? "job_failed", message: msg });
        }
        const bits = [rec.stage, rec.progress != null ? `${Math.round(rec.progress * 100)}%` : null, rec.etaText].filter(Boolean).join(", ");
        return ok(`Still building (${bits || "compiling"}).`, { scene: id, status: "compiling", stage: rec.stage, progress: rec.progress, eta: rec.etaText });
      }
      if (hasAccount) {
        const s = await client.scenes.get(id);
        const link = linkOf(s);
        return ok(`Done. Open the scene: ${link}`, { scene: id, status: "done", link, visibility: s.visibility });
      }
      throw new ToolError("That job is unknown or its record expired after 2 hours; set VERSE_API_KEY to your account token to look up older scenes.");
    }),
  );

  // ── list_scenes ───────────────────────────────────────────────────────
  server.registerTool(
    "list_scenes",
    {
      title: "List your scenes",
      description: "List the scenes owned by your Verse account, newest first: id, link, visibility, size, views and open review comments. Needs VERSE_API_KEY set to your account token.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of scenes to return.") },
      annotations: { title: "List scenes", readOnlyHint: true, openWorldHint: true },
    },
    guard(async (a: any) => {
      needAccount("Listing scenes");
      const all = await client.scenes.list();
      const scenes = all.slice(0, a.limit ?? 20).map((s) => ({
        id: s.id,
        link: linkOf(s),
        visibility: s.visibility,
        kind: s.path ?? s.kind,
        sizeMB: Math.round((s.sizeBytes / 1048576) * 10) / 10,
        created: new Date(s.created).toISOString(),
        opens: s.stats?.opens ?? 0,
        openReviews: s.reviews?.open ?? 0,
      }));
      const text = scenes.length ? scenes.map((s) => `${s.id}  ${s.visibility}  ${s.sizeMB} MB  ${s.link}`).join("\n") : "No scenes yet; upload one with upload_scene.";
      return ok(`${scenes.length} of ${all.length} scenes.\n${text}`, { total: all.length, scenes });
    }),
  );

  // ── create_share_link ─────────────────────────────────────────────────
  server.registerTool(
    "create_share_link",
    {
      title: "Create a share link (set visibility)",
      description:
        "Get a link to a scene you own, optionally changing who can open it. `visibility`: 'unlisted' (default; anyone with the link), 'public', or 'private' (opens only with a secret share token). " +
        "For a private scene this mints a share token and returns a link that includes it (the token is shown once; keep the returned `shareId` to revoke it with revoke_share_link). " +
        "Share links do not expire on their own; revoke them to cut access. Needs VERSE_API_KEY set to your account token.",
      inputSchema: {
        scene: sceneArg,
        visibility: z.enum(["public", "unlisted", "private"]).optional().describe("Set the scene's visibility first. Omit to keep it as is."),
        new_token: z.boolean().optional().describe("Mint a fresh private share token even if the scene is not private (e.g. to hand out revocable links)."),
        autoplay_tour: z.boolean().default(false).describe("Open the link playing the scene's camera path (see list_camera_paths)."),
      },
      annotations: { title: "Create share link", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (a: any) => {
      needAccount("Creating a share link");
      const id = sceneIdOf(a.scene);
      let visibility: string | undefined;
      if (a.visibility) visibility = (await client.scenes.setVisibility(id, a.visibility)).visibility;
      else visibility = (await client.scenes.get(id)).visibility;
      const rec = await resolveScene(id);
      let link: string;
      let shareId: string | undefined;
      if (visibility === "private" || a.new_token) {
        const t = await client.scenes.shares.create(id);
        link = client.shareLink(rec as any, { share: t.shareToken });
        shareId = t.id;
      } else {
        link = linkOf(rec);
      }
      if (a.autoplay_tour) link += `${link.includes("?") ? "&" : "?"}autoplay=path`;
      return ok(
        `${visibility === "private" ? "Private link (works for anyone who has it until revoked)" : "Link"}: ${link}`,
        { scene: id, visibility, link, ...(shareId ? { shareId } : {}) },
      );
    }),
  );

  server.registerTool(
    "revoke_share_link",
    {
      title: "Revoke a private share link",
      description: "Revoke one private share token so its link stops working. Use the `shareId` returned by create_share_link, or call with only `scene` to list the active share ids. Needs an account token.",
      inputSchema: { scene: sceneArg, share_id: z.string().min(1).max(64).optional().describe("The shareId to revoke. Omit to list active ones.") },
      annotations: { title: "Revoke share link", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async (a: any) => {
      needAccount("Revoking a share link");
      const id = sceneIdOf(a.scene);
      if (!a.share_id) {
        const list = await client.scenes.shares.list(id);
        return ok(list.length ? `Active share links: ${list.map((s) => `${s.id} (…${s.suffix})`).join(", ")}.` : "There are no active share links.", { scene: id, shares: list });
      }
      await client.scenes.shares.revoke(id, a.share_id);
      return ok(`Revoked share link ${a.share_id}.`, { scene: id, revoked: a.share_id });
    }),
  );

  // ── get_embed_code ────────────────────────────────────────────────────
  server.registerTool(
    "get_embed_code",
    {
      title: "Get embed code for a scene",
      description:
        "Get copy-paste code to embed a scene in a web page: an `iframe` (works anywhere), the `<verse-viewer>` element plus its `script`, and the plain `url`. " +
        "For a private scene pass the share token from create_share_link as `share_token`.",
      inputSchema: {
        scene: sceneArg,
        share_token: z.string().regex(/^[0-9a-f]{32}$/).optional().describe("Share token of a private scene."),
        aspect: z.enum(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "fill"]).optional().describe("Frame shape. Default 16:9."),
        load: z.enum(["lazy", "eager", "tap"]).optional().describe("'lazy' (default) loads when scrolled into view, 'tap' only on tap, 'eager' immediately."),
        background: z.string().max(40).optional().describe("'rrggbb', 'transparent' or 'studio:warm'."),
        title: z.string().max(120).optional().describe("Accessible title for the iframe."),
      },
      annotations: { title: "Embed code", readOnlyHint: true, openWorldHint: true },
    },
    guard(async (a: any) => {
      const id = sceneIdOf(a.scene);
      const rec = await resolveScene(id);
      const e = client.embedCode(rec as any, { share: a.share_token, aspect: a.aspect, load: a.load, background: a.background, title: a.title });
      return ok(`Embed with:\n${e.iframe}\n\nOr the web component:\n${e.script}\n${e.element}`, { scene: id, iframe: e.iframe, element: e.element, script: e.script, url: e.url });
    }),
  );

  // ── camera paths ──────────────────────────────────────────────────────
  const key = z.object({
    p: z.tuple([z.number(), z.number(), z.number()]).describe("Eye position [x,y,z] in metres (y up)."),
    f: z.tuple([z.number(), z.number(), z.number()]).describe("Forward direction [x,y,z]."),
    fov: z.number().min(5).max(150).optional(),
    dur: z.number().positive().max(600).optional().describe("Seconds to the next key (auto if omitted)."),
    hold: z.number().min(0).max(600).optional().describe("Seconds to dwell here."),
    ease: z.enum(["smooth", "stop", "linear"]).optional(),
    look: z.tuple([z.number(), z.number(), z.number()]).optional().describe("Look-at target."),
    label: z.string().max(80).optional().describe("Chapter name."),
  });

  server.registerTool(
    "list_camera_paths",
    {
      title: "List a scene's camera paths",
      description: "List the guided-tour camera paths of a scene (every scene gets an automatic default path after it builds) and the default one. Returns ids, names, modes (walk/fly), key counts and chapter labels, plus a ready-to-open `tourLink` that autoplays the default path.",
      inputSchema: { scene: sceneArg },
      annotations: { title: "List camera paths", readOnlyHint: true, openWorldHint: true },
    },
    guard(async (a: any) => {
      const id = sceneIdOf(a.scene);
      const r = await client.request<{ default: string | null; paths: { id: string; name: string; mode: string; keys: number; labels?: (string | null)[]; auto?: boolean }[] }>(`/v1/scenes/${encodeURIComponent(id)}/paths`);
      const base = linkOf(await resolveScene(id));
      const tourLink = `${base}${base.includes("?") ? "&" : "?"}autoplay=path`;
      const text = r.paths.length ? r.paths.map((p) => `${p.id}${p.id === r.default ? " (default)" : ""}  ${p.name}  ${p.mode}  ${p.keys} keys${p.auto ? "  auto" : ""}`).join("\n") : "No camera paths yet.";
      return ok(`${text}\nTour link: ${tourLink}`, { scene: id, default: r.default, paths: r.paths, tourLink });
    }),
  );

  server.registerTool(
    "set_camera_path",
    {
      title: "Create a camera path (guided tour)",
      description:
        "Create a camera path: a guided walk or fly-through the share link can play. Give 2 to 256 keyframes, each with an eye position `p`, forward direction `f` and optional fov, dwell `hold`, `ease`, look-at target and chapter `label`. " +
        "The first path becomes the scene's default; set `make_default` to promote later ones. If you only want a good default tour, use reset_auto_camera_path instead. Owner only; needs an account token.",
      inputSchema: {
        scene: sceneArg,
        name: z.string().min(1).max(80).default("Walkthrough"),
        mode: z.enum(["walk", "fly"]).default("walk").describe("'walk' keeps eye height over the floor and avoids walls; 'fly' goes anywhere."),
        keys: z.array(key).min(2).max(256),
        speed: z.number().positive().max(100).optional().describe("Metres per second for keys without `dur`."),
        make_default: z.boolean().default(false),
      },
      annotations: { title: "Create camera path", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (a: any) => {
      needAccount("Creating a camera path");
      const id = sceneIdOf(a.scene);
      const body: Record<string, unknown> = { name: a.name, mode: a.mode, keys: a.keys };
      if (a.speed) body.speed = a.speed;
      const r = await client.request<{ id: string; default: boolean; keys: number }>(`/v1/scenes/${encodeURIComponent(id)}/paths`, { method: "POST", body, retries: 0 });
      if (a.make_default && !r.default) await client.request(`/v1/scenes/${encodeURIComponent(id)}/paths`, { method: "PUT", body: { default: r.id } });
      const base = linkOf(await resolveScene(id));
      const tourLink = `${base}${base.includes("?") ? "&" : "?"}autoplay=path&path=${r.id}`;
      return ok(`Created path ${r.id} with ${r.keys} keys. Tour link: ${tourLink}`, { scene: id, pathId: r.id, keys: r.keys, default: r.default || !!a.make_default, tourLink });
    }),
  );

  server.registerTool(
    "reset_auto_camera_path",
    {
      title: "Plan the automatic tour",
      description: "Re-plan the scene's automatic camera path (an eye-height walkthrough for interiors, a drone fly-through for exteriors, a 360 orbit for products) and make it the default. Returns a link that autoplays it. Owner only; needs an account token.",
      inputSchema: { scene: sceneArg },
      annotations: { title: "Plan automatic tour", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (a: any) => {
      needAccount("Planning a tour");
      const id = sceneIdOf(a.scene);
      const r = await client.request<{ id: string; name: string; mode: string; kind: string; keys: unknown[] }>(`/v1/scenes/${encodeURIComponent(id)}/paths/auto`, { method: "POST", retries: 0 });
      const base = linkOf(await resolveScene(id));
      const tourLink = `${base}${base.includes("?") ? "&" : "?"}autoplay=path`;
      return ok(`Planned a ${r.kind} tour "${r.name}" (${r.keys.length} keys). Tour link: ${tourLink}`, { scene: id, pathId: r.id, kind: r.kind, tourLink });
    }),
  );

  return server;
}
