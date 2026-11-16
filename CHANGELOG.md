# Changelog

## 0.1.1

- Hosted (Streamable HTTP) servers hand the agent links on their public origin (`publicBaseUrl`, derived from `X-Forwarded-Proto` / `X-Forwarded-Host` by default), never the API loopback.
- The hosted server's instructions no longer mention local file paths.
- Messages start with a capital and read as one sentence; a vowel kind gets "an"; upload progress never steps back.

## 0.1.0

First release.

- Tools: `upload_scene` (local path or public URL, resumable above 100 MB, progress notifications, waits for the build), `get_scene_status`, `list_scenes`, `create_share_link`, `revoke_share_link`, `get_embed_code`, `list_camera_paths`, `set_camera_path`, `reset_auto_camera_path`.
- Transports: stdio (`npx -y @ctruhtech/verse-mcp`) and stateless Streamable HTTP (`--http`, or `createHttpHandler()` to mount at `/mcp`); the hosted endpoint is `https://verse.ctruh.com/mcp`.
- Credentials: `VERSE_API_KEY` takes a workspace API key (`vk_...`, Account page) or an account token; both ride as `Authorization: Bearer`. `VERSE_UPLOAD_KEY` for self-hosted keyed servers. Keys are never logged or returned.
- Errors are one plain sentence; a missing key on the remote endpoint is a `401` with `WWW-Authenticate`.
