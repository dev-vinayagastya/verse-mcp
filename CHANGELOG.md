# Changelog

## 0.1.5

- Tool descriptions state real limits (file size by plan, hourly upload and upload-link allowances, tours per scene, keys per tour) and add parameter guidance the schemas cannot carry.

## 0.1.4

- New tool `delete_camera_path`: remove a guided tour from a scene (owner only; `default` deletes the tour that plays by default).

## 0.1.3

- Every tool now says when to use it, when to use a sibling instead, what its parameters mean beyond their types, and its side effects, auth and limits.
- Output schemas on all 11 tools, so clients get typed results.
- Every parameter described, including camera-path keyframe fields.

## 0.1.2

- Two new tools: `create_upload_link` (a 30-minute, single-use page where someone drops a file the assistant cannot pass on, such as a big file on a phone) and `get_upload_link_status`.
- Remote server: sign in with your Verse account (OAuth 2.1, no API key to copy) at `https://verse.ctruh.com/mcp`.
- README and docs lead with sign-in; registry name `com.ctruh.verse/verse`.

## 0.1.1

- Publishing metadata and README links.

## 0.1.0

First release.

- Tools: `upload_scene` (local path or public URL, resumable above 100 MB, progress notifications, waits for the build), `get_scene_status`, `list_scenes`, `create_share_link`, `revoke_share_link`, `get_embed_code`, `list_camera_paths`, `set_camera_path`, `reset_auto_camera_path`.
- Transports: stdio (`npx -y @ctruhtech/verse-mcp`) and stateless Streamable HTTP (`--http`, or `createHttpHandler()` to mount at `/mcp`); the hosted endpoint is `https://verse.ctruh.com/mcp`.
- Credentials: `VERSE_API_KEY` takes a workspace API key (`vk_...`, Account page) or an account token; both ride as `Authorization: Bearer`. `VERSE_UPLOAD_KEY` for self-hosted keyed servers. Keys are never logged or returned.
- Errors are one plain sentence; a missing key on the remote endpoint is a `401` with `WWW-Authenticate`.
