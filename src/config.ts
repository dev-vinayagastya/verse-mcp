import { VerseClient } from "@ctruhtech/verse-sdk";

export const VERSION = "0.1.2";
export const DEFAULT_BASE_URL = "https://verse.ctruh.com";

export interface Credentials {
  /**
   * What goes in `Authorization: Bearer`: a workspace API key `vk_...`
   * (Account page, "API keys" card; acts as a member of that workspace) or
   * an account token (64 hex, Studio). Either owns what it uploads and
   * unlocks list / visibility / share / paths.
   */
  token?: string | null;
  /** `X-API-Key` for a self-hosted server in keyed mode (`VERSE_UPLOAD_KEY`); never needed on verse.ctruh.com. */
  apiKey?: string | null;
}

/**
 * VERSE_API_KEY holds the Bearer credential: a workspace API key (`vk_...`)
 * or an account token. Both ride as `Authorization: Bearer`, which is how
 * the hosted service recognises a signed-in caller. The value is never
 * logged or echoed.
 */
export function classifyKey(value: string | undefined | null): Credentials {
  const v = (value ?? "").trim();
  if (!v) return {};
  return { token: v };
}

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials {
  const c = classifyKey(env.VERSE_API_KEY);
  const tok = (env.VERSE_ACCOUNT_TOKEN ?? "").trim();
  if (tok) c.token = tok;
  const up = (env.VERSE_UPLOAD_KEY ?? "").trim();
  if (up) c.apiKey = up;
  return c;
}

export function baseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.VERSE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function makeClient(baseUrl: string, creds: Credentials, fetchImpl?: typeof fetch): VerseClient {
  return new VerseClient({
    baseUrl,
    token: creds.token ?? null,
    apiKey: creds.apiKey ?? null,
    source: `verse-mcp/${VERSION}`,
    telemetry: false,
    pollIntervalMs: 2500,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
