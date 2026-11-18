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
  /**
   * The origin links are written with, when it differs from `baseUrl`: a
   * hosted server talks to its own API over loopback but must hand the
   * agent links on its public address. Default `baseUrl`.
   */
  publicBaseUrl?: string;
}

const instructionsFor = (localFiles: boolean) =>
  "Verse Engine publishes any 3D scene, walkthrough or model (a file or public URL: GLB, glTF, FBX, OBJ, IFC, USD/USDZ, PLY, SPLAT, SPZ-class captures, point clouds), from a single product to a whole city, as a shareable link that opens in any browser, with no app and no plugin. " +
  (localFiles
    ? "Use upload_scene with a local file path or a public URL, then share the returned link or call get_embed_code for an iframe. "
    : "Use upload_scene with a public http(s) URL (this hosted server cannot read local files), then share the returned link or call get_embed_code for an iframe. " +
      "When the user has a 3D file on their device or attached in the chat but no public URL, call create_upload_link, give them the link, and once they say it is uploaded poll get_upload_link_status. ") +
  "Owner actions (list_scenes, visibility, private share links, camera paths) need the user's Verse account token in VERSE_API_KEY. " +
  "Builds can take a minute or more for large files; if upload_scene returns before the build is done, poll get_scene_status.";

const sceneArg = z.string().min(3).max(600).describe("Scene id (e.g. palm-villa-0a1b2c3d4e5f), the job id returned by upload_scene, or a Verse share link.");

const KINDS = ["splat", "cloud", "ifc", "usd", "fbx", "obj"] as const;

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const okRaw = (text: string, data?: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}) });

export function createVerseServer(opts: ServerOptions): McpServer {
  const client: VerseClient = makeClient(opts.baseUrl, opts.credentials, opts.fetch);
  if (opts.pollIntervalMs) (client as unknown as { pollIntervalMs: number }).pollIntervalMs = opts.pollIntervalMs;
  const hasAccount = !!opts.credentials.token;
  const server = new McpServer({ name: "verse", version: VERSION }, { instructions: instructionsFor(opts.allowLocalFiles) });
  const apiBase = opts.baseUrl.replace(/\/+$/, "");
  const linkBase = (opts.publicBaseUrl || apiBase).replace(/\/+$/, "");
  /** Rewrite the API origin to the public one in anything handed to the agent. */
  const pub = <T>(v: T): T => {
    if (linkBase === apiBase || v == null) return v;
    if (typeof v === "string") return v.split(apiBase).join(linkBase) as T;
    if (Array.isArray(v)) return v.map(pub) as T;
    if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, pub(x)])) as T;
    return v;
  };

  const ok = (text: string, data?: Record<string, unknown>): ToolResult => okRaw(pub(text), data ? pub(data) : undefined);

  const needAccount = (what: string) => {
    if (!hasAccount) throw new ToolError(`${what} needs a Verse key; set VERSE_API_KEY to an API key from your Account page (${linkBase}/account, "API keys") or your account token.`);
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
      if (progress <= last) return; // never report a step backwards
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
      title: "Publish a 3D scene and get a Verse link",
      description:
        "Publish a 3D file as a Verse scene and return a link that opens in any browser, from a single product to a walkable building or a whole city. " +
        "Use it when you have a public http(s) URL, or a path on this machine (local server only). If the user has the file but no public URL, use create_upload_link; to re-share an existing scene, use create_share_link. " +
        "Parameters: `source` links must be directly downloadable (Dropbox dl=1, Google Drive 'anyone with the link', S3/R2/GCS presigned). Leave `kind`, `as` and `path` unset unless the guess would be wrong, e.g. a Gaussian-splat .ply is `kind` 'splat'. `visibility` applies once the build finishes. `wait_seconds` 0 returns as soon as the upload is accepted. " +
        "Formats: GLB, glTF, FBX, OBJ, IFC, USD/USDZ, PLY, SPLAT, LAS/LAZ/E57. " +
        "Limits: up to 1 GB per file on the free plan and 20 GB on paid plans; 20 uploads an hour per account, and files over 500 MB count against a smaller hourly allowance (2 on free). Files over 100 MB go up in resumable parts with progress notifications. A product usually builds in seconds; a large walkable scene can take many minutes, in which case status comes back 'compiling' and you poll get_scene_status. " +
        "Every call creates a new scene in the user's workspace, unlisted unless `visibility` says otherwise. Requires sign-in (connector sign-in, or VERSE_API_KEY for the local server).",
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
      outputSchema: { scene: z.string().describe("Scene id."), status: z.string().describe("'done' or 'compiling' (still building; poll get_scene_status)."), link: z.string().nullable().optional().describe("Link that opens the scene in any browser."), kind: z.string().nullable().optional().describe("How it was published: 'fidelity' (as-is product) or 'streamed' (walkable scene)."), visibility: z.string().nullable().optional().describe("public, unlisted or private, when set."), arUrl: z.string().nullable().optional().describe("USDZ link for iPhone AR, products only."), fixes: z.any().nullable().optional().describe("Repairs Verse applied to the file, if any.") },
      annotations: { title: "Publish a 3D scene", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
        "Check whether a scene has finished building and get its link once it has. " +
        "Use it after upload_scene returned 'compiling', or when the user asks if a scene is ready; poll every 10 to 30 seconds. For upload links use get_upload_link_status; to browse all scenes use list_scenes. " +
        "Parameter: `scene` can be the job id from upload_scene, the scene id, or a Verse link the user pasted. Job ids resolve for 2 hours after upload; after that pass the scene id or link, which is looked up in the signed-in account. " +
        "Read-only and free to call repeatedly. A failed build returns a plain message saying what to fix (for example an unsupported file inside a zip). Older scenes need sign-in; a build started in this session does not.",
      inputSchema: { scene: sceneArg },
      outputSchema: { scene: z.string().describe("Scene id."), status: z.string().describe("'compiling', 'done' or 'error'."), link: z.string().nullable().optional().describe("Link that opens the scene in any browser."), arUrl: z.string().nullable().optional().describe("USDZ link for iPhone AR, products only."), visibility: z.string().nullable().optional().describe("public, unlisted or private."), stage: z.string().nullable().optional().describe("Current build stage while compiling."), progress: z.number().nullable().optional().describe("Build progress 0..1 while compiling."), eta: z.string().nullable().optional().describe("Estimated time left while compiling."), error: z.string().nullable().optional().describe("Error code when status is 'error'."), message: z.string().nullable().optional().describe("Plain explanation of the failure and how to fix it.") },
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

  // ── create_upload_link / get_upload_link_status ───────────────────────
  // For a file the user has but cannot hand over (a chat attachment, a file on their phone): a
  // short-lived, single-use page where they drop it; the upload is owned by this account.
  const doFetch = opts.fetch ?? fetch;
  async function api(method: string, path: string, body?: unknown): Promise<any> {
    const r = await doFetch(`${apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${opts.credentials.token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.credentials.apiKey ? { "X-API-Key": opts.credentials.apiKey } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.status === 404) throw new ToolError("That upload link is unknown or belongs to another account; create a new one with create_upload_link.");
    if (r.status === 401) throw new ToolError("The server rejected the Verse credential; check VERSE_API_KEY or sign in again.");
    if (r.status === 429) throw new ToolError("Too many upload links in the last hour; try again later.");
    if (!r.ok) throw new ToolError(j?.errorInfo?.message || j?.error || `Verse answered ${r.status}.`);
    return j;
  }
  const dropTokenOf = (v: string): string => {
    const s = String(v ?? "").trim();
    const m = /\/drop\/([A-Za-z0-9_-]{22})(?:[/?#]|$)/.exec(s) ?? /^([A-Za-z0-9_-]{22})$/.exec(s);
    if (!m) throw new ToolError("That does not look like a Verse upload link or its token.");
    return m[1];
  };

  server.registerTool(
    "create_upload_link",
    {
      title: "Create an upload link for a file the user has",
      description:
        "Create a one-time web page where the user drops a 3D file you cannot pass to this server, such as a chat attachment or a file on their phone. " +
        "Use it only when the file has no public URL and you cannot read the user's disk; with a public URL, upload_scene is faster. " +
        "Parameters: set `as` if the user said what the file is ('product' for one object; 'interior', 'building' or 'exterior' for walkable scenes) so Verse skips guessing; `name` pre-fills the scene id, which the user can still change on the page. " +
        "Give the user the link and the returned instructions, wait until they say it is uploaded, then call get_upload_link_status. " +
        "Each link accepts one file, expires after 30 minutes, and uploads into the user's own account with their plan's file-size cap (1 GB free, up to 20 GB paid). Up to 60 links an hour per account. Requires sign-in (connector sign-in, or VERSE_API_KEY for the local server).",
      inputSchema: {
        name: z.string().regex(/^[a-z0-9_-]{1,48}$/).optional().describe("Optional slug for the scene id, lowercase letters, digits, - and _ (the user can change it on the page)."),
        as: z.enum(["product", "interior", "building", "exterior"]).optional().describe("What the file is, if the user said: a 'product' (a single object) or a walkable 'interior'/'building'/'exterior'."),
      },
      outputSchema: { link: z.string().describe("The one-time upload page to give the user."), instructions: z.string().describe("Text to show the user with the link."), expiresAt: z.union([z.string(), z.number()]).nullable().optional().describe("When the link stops working."), singleUse: z.boolean().nullable().optional().describe("Always true: the link accepts one upload.") },
      annotations: { title: "Create upload link", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (a: any) => {
      needAccount("Creating an upload link");
      const j = await api("POST", "/v1/upload-links", { ...(a.name ? { name: a.name } : {}), ...(a.as ? { as: a.as } : {}) });
      const minutes = Math.max(1, Math.round((j.expiresInS ?? 1800) / 60));
      return ok(`${j.url}\n${j.instructions} The link works once and expires in ${minutes} minutes.`, { link: j.url, instructions: j.instructions, expiresAt: j.expiresAt, singleUse: true });
    }),
  );

  server.registerTool(
    "get_upload_link_status",
    {
      title: "Check an upload link",
      description:
        "Check what happened to a link from create_upload_link. " +
        "Use it after the user says they dropped the file, or to see whether they have; for scenes from upload_scene use get_scene_status. " +
        "Parameter: `link` takes the full link or just the 22-character token after /drop/; a link created by another account reads as unknown. " +
        "Read-only and free to repeat; poll every 10 to 30 seconds while the state is uploading or building. When done, pass the returned `scene` to get_embed_code, create_share_link or set_camera_path; if expired, create a new link. Requires sign-in (connector sign-in, or VERSE_API_KEY for the local server).",
      inputSchema: { link: z.string().min(22).max(600).describe("The upload link from create_upload_link (or its token).") },
      outputSchema: { state: z.string().describe("waiting, uploading, building, done, failed or expired."), scene: z.string().nullable().optional().describe("Scene id once done."), link: z.string().nullable().optional().describe("Link that opens the scene in any browser."), progress: z.number().nullable().optional().describe("Build progress 0..1 while building."), message: z.string().nullable().optional().describe("Why it failed, when state is failed.") },
      annotations: { title: "Upload link status", readOnlyHint: true, openWorldHint: true },
    },
    guard(async (a: any) => {
      needAccount("Checking an upload link");
      const s = await api("GET", `/v1/upload-links/${dropTokenOf(a.link)}`);
      const text =
        s.state === "done"
          ? `Done. Open the scene: ${s.link}`
          : s.state === "failed"
            ? `The build failed: ${s.message ?? "unknown reason"}`
            : s.state === "building"
              ? `Uploaded; still building${typeof s.progress === "number" ? ` (${Math.round(s.progress * 100)}%)` : ""}.`
              : s.state === "uploading"
                ? "The file is uploading."
                : s.state === "expired"
                  ? "The link expired before a file was uploaded; create a new one."
                  : "Waiting for the user to drop a file on the page.";
      return ok(text, s);
    }),
  );

  // ── list_scenes ───────────────────────────────────────────────────────
  server.registerTool(
    "list_scenes",
    {
      title: "List your scenes",
      description:
        "List the scenes in the user's Verse workspace, newest first. " +
        "Use it to find a scene id when the user refers to a scene by name or date (\"my villa from yesterday\"), or to show what they have published; for one known scene use get_scene_status. " +
        "Parameter: `limit` (1 to 100, default 20); use 5 to 10 when looking for something recent. The response always carries `total`, so you can tell whether older scenes were left out. " +
        "Read-only. Includes view counts and open review comments, useful for answering \"which scene gets the most views\". Requires sign-in (connector sign-in, or VERSE_API_KEY for the local server).",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of scenes to return.") },
      outputSchema: { total: z.number().describe("Scenes in the account."), scenes: z.array(z.object({ id: z.string(), link: z.string(), visibility: z.string().nullable().optional(), kind: z.string().nullable().optional(), sizeMB: z.number().nullable().optional(), created: z.string().nullable().optional(), opens: z.number().nullable().optional(), openReviews: z.number().nullable().optional() })).describe("Newest first: id, link, visibility, kind, size in MB, creation time, view count and open review comments.") },
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
        "Get a link to a scene the user owns, optionally changing who can open it. " +
        "Use it when the user wants to send or post a scene, or change it to public, unlisted or private; to cut off a link use revoke_share_link; for website code use get_embed_code. " +
        "Parameters: `visibility` 'unlisted' (anyone with the link; the default for new scenes), 'public' (also listed) or 'private' (opens only with a secret token); omit it to keep the current setting. `new_token` gives a revocable link without making the scene private. `autoplay_tour` starts the default camera tour on open. " +
        "Side effects: changes the scene's visibility when `visibility` is given, and every token call creates another token. The token is shown only once; keep `shareId` to revoke it. Links never expire on their own. Requires sign-in (connector sign-in, or VERSE_API_KEY for the local server).",
      inputSchema: {
        scene: sceneArg,
        visibility: z.enum(["public", "unlisted", "private"]).optional().describe("Set the scene's visibility first. Omit to keep it as is."),
        new_token: z.boolean().optional().describe("Mint a fresh private share token even if the scene is not private (e.g. to hand out revocable links)."),
        autoplay_tour: z.boolean().default(false).describe("Open the link playing the scene's camera path (see list_camera_paths)."),
      },
      outputSchema: { scene: z.string().describe("Scene id."), visibility: z.string().nullable().optional().describe("The scene's visibility after the call."), link: z.string().describe("The link to share."), shareId: z.string().nullable().optional().describe("Id of the minted token, for revoke_share_link.") },
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
      description:
        "Revoke one private share token so the link containing it stops opening the scene, or list the active tokens. " +
        "Use it when the user wants to cut off a link they sent: call with only `scene` to list active `shareId`s, then again with `share_id`. To make the whole scene public or unlisted again, use create_share_link. " +
        "Parameters: `scene` (id or link) and optional `share_id` from create_share_link or the list call; the list shows each token's last characters so the user can tell links apart. " +
        "Takes effect immediately and cannot be undone; that link stops opening the scene for everyone who has it. Other tokens and the scene are untouched. Requires sign-in (connector sign-in, or VERSE_API_KEY for the local server).",
      inputSchema: { scene: sceneArg, share_id: z.string().min(1).max(64).optional().describe("The shareId to revoke. Omit to list active ones.") },
      outputSchema: { scene: z.string().describe("Scene id."), shares: z.array(z.any()).nullable().optional().describe("Active share tokens (id and last characters), when listing."), revoked: z.string().nullable().optional().describe("The share id that was revoked.") },
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
        "Get copy-paste code to show a scene inside a web page. " +
        "Use it when the user wants the scene on their website, store or CMS; for a link to send in a message, use create_share_link. " +
        "Parameters: `aspect` sets the frame shape ('fill' takes the parent's size, for full-bleed heroes); `load` 'lazy' saves bandwidth below the fold, 'tap' suits pages with many scenes, 'eager' suits a single hero; `background` is hex without #, 'transparent' to sit on the page colour, or 'studio:warm'; `share_token` is required for a private scene and is the token inside the link create_share_link returned. " +
        "Read-only and makes no change to the scene; works without sign-in for public and unlisted scenes.",
      inputSchema: {
        scene: sceneArg,
        share_token: z.string().regex(/^[0-9a-f]{32}$/).optional().describe("Share token of a private scene."),
        aspect: z.enum(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "fill"]).optional().describe("Frame shape. Default 16:9."),
        load: z.enum(["lazy", "eager", "tap"]).optional().describe("'lazy' (default) loads when scrolled into view, 'tap' only on tap, 'eager' immediately."),
        background: z.string().max(40).optional().describe("'rrggbb', 'transparent' or 'studio:warm'."),
        title: z.string().max(120).optional().describe("Accessible title for the iframe."),
      },
      outputSchema: { scene: z.string().describe("Scene id."), iframe: z.string().describe("Iframe HTML that works in any site builder."), element: z.string().describe("<verse-viewer> element HTML."), script: z.string().describe("Script tag that loads the <verse-viewer> component."), url: z.string().describe("Plain embed URL.") },
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
    f: z.tuple([z.number(), z.number(), z.number()]).describe("Forward direction [x,y,z], required and non-zero; need not be normalised. When `look` is set, the camera aims at that point instead."),
    fov: z.number().min(5).max(150).optional().describe("Vertical field of view in degrees at this key (default 60)."),
    dur: z.number().positive().max(600).optional().describe("Seconds to the next key (auto if omitted)."),
    hold: z.number().min(0).max(600).optional().describe("Seconds to dwell here."),
    ease: z.enum(["smooth", "stop", "linear"]).optional().describe("Motion into this key: 'smooth' (default) eases through, 'stop' comes to rest, 'linear' keeps constant speed."),
    look: z.tuple([z.number(), z.number(), z.number()]).optional().describe("Look-at target."),
    label: z.string().max(80).optional().describe("Chapter name."),
  });

  server.registerTool(
    "list_camera_paths",
    {
      title: "List a scene's camera paths",
      description:
        "List the guided camera tours of a scene and which one plays by default. " +
        "Use it before editing tours, or to give the user a tour link; every scene gets an automatic default tour after it builds. To create a tour use set_camera_path, to regenerate the automatic one use reset_auto_camera_path, and to remove one use delete_camera_path. " +
        "Parameter: `scene` is the scene id, job id or a link the user pasted; the returned path ids are what set_camera_path, delete_camera_path and tour links use. " +
        "Read-only. Works without sign-in for public and unlisted scenes; private scenes need the owner signed in.",
      inputSchema: { scene: sceneArg },
      outputSchema: { scene: z.string().describe("Scene id."), default: z.string().nullable().describe("Id of the tour links play by default."), paths: z.array(z.any()).describe("Tours with id, name, mode, key count, chapter labels and auto flag."), tourLink: z.string().describe("Link that opens the scene playing the default tour.") },
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
        "Create a custom guided camera tour, a scripted walk or fly-through that share links can play. " +
        "Use it when the user wants a specific route, order of rooms or framing; for a good tour without choosing a route, use reset_auto_camera_path. " +
        "Parameters: keyframes use scene metres with y up. Every key needs a non-zero forward vector `f`; add `look` to keep a target point centred, which takes over aiming at that key. Keys without `dur` are timed from `speed`; `hold` pauses at a key, which suits a room reveal. In 'walk' mode the camera keeps eye height and steers around walls, so put keys in open floor space; 'fly' moves freely and suits exteriors. " +
        "Limits: 2 to 256 keys per tour and up to 24 tours per scene. Each call adds a new tour and keeps the others; the first tour on a scene becomes the default unless another is. Owner only. Requires sign-in (connector sign-in, or VERSE_API_KEY for the local server).",
      inputSchema: {
        scene: sceneArg,
        name: z.string().min(1).max(80).default("Walkthrough").describe("Tour name shown to viewers, e.g. 'Ground floor walkthrough'."),
        mode: z.enum(["walk", "fly"]).default("walk").describe("'walk' keeps eye height over the floor and avoids walls; 'fly' goes anywhere."),
        keys: z.array(key).min(2).max(256).describe("Keyframes in order; the camera moves through them from first to last."),
        speed: z.number().positive().max(100).optional().describe("Metres per second for keys without `dur`."),
        make_default: z.boolean().default(false).describe("Make this the tour that share links and autoplay use."),
      },
      outputSchema: { scene: z.string().describe("Scene id."), pathId: z.string().describe("Id of the new tour."), keys: z.number().describe("Keyframes saved."), default: z.boolean().describe("Whether links now play this tour by default."), tourLink: z.string().describe("Link that opens the scene playing this tour.") },
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
      description:
        "Plan a fresh automatic tour for a scene and make it the default: an eye-height walkthrough for interiors, a drone fly-through for exteriors or a 360-degree orbit for products. " +
        "Use it when the user wants a tour without choosing a route, or after the scene changed; for a hand-picked route use set_camera_path. " +
        "Parameter: `scene` only; the scene must have finished building (check get_scene_status), and the tour type comes from its content, not from you. " +
        "Replaces the scene's default with the new plan; custom tours from set_camera_path are kept. Safe to repeat. Owner only. Requires sign-in (connector sign-in, or VERSE_API_KEY for the local server).",
      inputSchema: { scene: sceneArg },
      outputSchema: { scene: z.string().describe("Scene id."), pathId: z.string().describe("Id of the planned tour."), kind: z.string().nullable().describe("walkthrough, fly-through or orbit."), tourLink: z.string().describe("Link that opens the scene playing it.") },
      annotations: { title: "Plan automatic tour", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (a: any) => {
      needAccount("Planning a tour");
      const id = sceneIdOf(a.scene);
      const r = await client.request<{ id: string; name: string; mode: string; kind: string; keys: unknown[] }>(`/v1/scenes/${encodeURIComponent(id)}/paths/auto`, { method: "POST", retries: 0 });
      const base = linkOf(await resolveScene(id));
      const tourLink = `${base}${base.includes("?") ? "&" : "?"}autoplay=path`;
      const article = /^[aeiou]/i.test(String(r.kind)) ? "an" : "a";
      return ok(`Planned ${article} ${r.kind} tour "${r.name}" (${r.keys.length} keys). Tour link: ${tourLink}`, { scene: id, pathId: r.id, kind: r.kind, tourLink });
    }),
  );

  server.registerTool(
    "delete_camera_path",
    {
      title: "Delete a camera path",
      description:
        "Delete one guided camera tour from a scene. " +
        "Use it when the user wants to remove a tour they no longer want; to replace the automatic tour with a fresh plan use reset_auto_camera_path, and to add a tour use set_camera_path. " +
        "Parameters: `scene` (id or link) and `path_id` from list_camera_paths or set_camera_path; 'default' deletes whichever tour currently plays by default. " +
        "Permanent: the tour cannot be restored, though reset_auto_camera_path can plan a new automatic one. If it was the default, links play no tour until another is made default. Other tours and the scene are untouched. Owner only. Requires sign-in (connector sign-in, or VERSE_API_KEY for the local server).",
      inputSchema: {
        scene: sceneArg,
        path_id: z.string().min(1).max(40).describe("Id of the tour to delete, as listed by list_camera_paths, or 'default' for the tour that currently plays by default."),
      },
      outputSchema: { scene: z.string().describe("Scene id."), deleted: z.string().describe("Id of the tour that was deleted."), default: z.string().nullable().describe("Id of the tour that now plays by default, or null if none.") },
      annotations: { title: "Delete camera path", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard(async (a: any) => {
      needAccount("Deleting a camera path");
      const id = sceneIdOf(a.scene);
      const r = await client.request<{ deleted: string; default: string | null }>(`/v1/scenes/${encodeURIComponent(id)}/paths/${encodeURIComponent(a.path_id)}`, { method: "DELETE", retries: 0 });
      return ok(`Deleted tour ${r.deleted}.${r.default ? ` The default tour is now ${r.default}.` : " No tour plays by default now; use reset_auto_camera_path or set_camera_path with make_default."}`, { scene: id, deleted: r.deleted, default: r.default ?? null });
    }),
  );

  return server;
}
