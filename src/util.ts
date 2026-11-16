import { VerseError } from "@ctruhtech/verse-sdk";

/** Pull a scene id out of an id, a share link, an ingest URL or a /v1 path. */
export function sceneIdOf(input: string): string {
  const s = input.trim();
  const m =
    /[?&](?:vpk|vsp|vpc|glb|model|scene)=(?:[^&]*?ingest\/|)([A-Za-z0-9_-]+?)(?:\.fidelity)?(?:\.(?:vpk|vsp|vpc|glb|stage|usdz)|(?=&|$))/.exec(s) ||
    /\/ingest\/([A-Za-z0-9_-]+?)(?:\.[a-z.]+)?(?:[?#]|$)/.exec(s) ||
    /\/v1\/(?:ingest|scenes)\/([A-Za-z0-9_-]+)/.exec(s);
  const id = m ? m[1] : s;
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(id)) throw new ToolError("That does not look like a Verse scene id or link.");
  return id;
}

/** A failure whose message is already the one plain sentence for the model. */
export class ToolError extends Error {}

const sentence = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
};

/** One plain sentence for any failure; never includes credentials. */
export function plainError(e: unknown, hasAccount: boolean): string {
  if (e instanceof ToolError) return sentence(e.message);
  if (e instanceof VerseError) {
    if (e.status === 401 && !hasAccount) return "Uploading needs a free Verse account: sign up at verse.ctruh.com/signin, create an API key on your Account page and set it as VERSE_API_KEY.";
    if (e.status === 401) return "The server rejected the Verse credential; check VERSE_API_KEY.";
    if (e.status === 404 && e.code !== "unknown_job" && !hasAccount) return "Not found, and no account token is set; owner-only actions need VERSE_API_KEY set to your account token.";
    if (e.code === "unknown_job") return "That job is unknown or its record expired after 2 hours; use list_scenes to find the scene.";
    if (e.code === "timeout") return "Timed out waiting for the build; it is probably still running, so check it with get_scene_status.";
    const info = e.errorInfo;
    const msg = info?.message || e.message;
    const fix = info?.fix && !msg.includes(info.fix) ? ` ${info.fix}` : "";
    return sentence(scrub(`${msg}${fix}`).slice(0, 400));
  }
  const m = (e as Error)?.message ?? String(e);
  return sentence(scrub(m).slice(0, 300));
}

/** Defensive: strip anything shaped like a credential from a message. */
export function scrub(s: string): string {
  return s.replace(/\bvk_[A-Za-z0-9]{6,}\b/g, "vk_***").replace(/\b[0-9a-f]{32,64}\b/gi, "***");
}
