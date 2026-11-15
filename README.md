# @ctruhtech/verse-mcp

An [MCP](https://modelcontextprotocol.io) server for [Verse](https://verse.ctruh.com). It lets AI assistants and agents (Claude, ChatGPT, Cursor, VS Code, your own) turn a 3D file into a shareable link that opens in any browser, then embed it, make it private, or give it a guided tour.

```
"Upload ~/Models/villa.glb to Verse and give me a link."
"Make that scene private and give me a link I can send to the client."
"Give me the embed code for it, 1:1."
```

Node 20 or newer. MIT licensed. Documentation: <https://verse.ctruh.com/docs/#/mcp>.

## 60-second setup

1. Sign up free at <https://verse.ctruh.com/signin>, open your Account page and create a key under **API keys** (it is shown once).
2. Add the server to your client with that key as `VERSE_API_KEY`:

```sh
claude mcp add verse --env VERSE_API_KEY=paste-your-key -- npx -y @ctruhtech/verse-mcp
```

3. Ask: "Upload ~/Models/villa.glb to Verse and give me a link."

Other clients are below. Nothing is installed globally: `npx -y @ctruhtech/verse-mcp` fetches the package on first use.

## Tools

| Tool | What it does |
| --- | --- |
| `upload_scene` | Local path or public URL, to a Verse link. Resumable for big files, progress notifications, waits for the build. |
| `get_scene_status` | Build state, progress and ETA; the link once done. |
| `list_scenes` | Scenes owned by your account. |
| `create_share_link` | Set visibility (public / unlisted / private); private scenes get a revocable share-token link. Optional autoplay of the camera path. |
| `revoke_share_link` | Revoke a private share token (or list the active ones). |
| `get_embed_code` | iframe, `<verse-viewer>` element and plain URL. |
| `list_camera_paths`, `set_camera_path`, `reset_auto_camera_path` | Guided tours: read, author, or re-plan the automatic fly-through. |

Every tool is a thin wrapper over the public REST API ([API reference](https://verse.ctruh.com/docs/#/api)) through [`@ctruhtech/verse-sdk`](https://www.npmjs.com/package/@ctruhtech/verse-sdk). There is no world-generation tool, because the API has no such endpoint. Share links do not expire on their own; the API has no expiry, so revoke a private link to end access. Errors come back as one plain sentence.

## Credentials

Set `VERSE_API_KEY` to one of:

- a **workspace API key** `vk_...` from your Account page (**API keys** card). It acts as a member of that workspace: uploads, scenes, visibility, private links and camera paths;
- your **account token** (64 hex, from Studio). Same powers, tied to you.

Both are sent as `Authorization: Bearer`. Uploading needs a free Verse account; opening a published link never does. `VERSE_BASE_URL` points at another origin (default `https://verse.ctruh.com`). The key is only ever sent to that origin as a header, and is never logged or returned in tool output. `VERSE_UPLOAD_KEY` (optional) is the `X-API-Key` of a self-hosted server running in keyed mode.

## Setup (stdio)

**Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "verse": {
      "command": "npx",
      "args": ["-y", "@ctruhtech/verse-mcp"],
      "env": { "VERSE_API_KEY": "paste-your-key" }
    }
  }
}
```

**Claude Code**:

```sh
claude mcp add verse --env VERSE_API_KEY=paste-your-key -- npx -y @ctruhtech/verse-mcp
```

**Cursor**: `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project), same JSON as Claude Desktop.

**VS Code**: `.vscode/mcp.json`:

```json
{
  "inputs": [{ "type": "promptString", "id": "verse-key", "description": "Verse API key", "password": true }],
  "servers": {
    "verse": {
      "command": "npx",
      "args": ["-y", "@ctruhtech/verse-mcp"],
      "env": { "VERSE_API_KEY": "${input:verse-key}" }
    }
  }
}
```

## Remote (Streamable HTTP)

For clients that connect to a URL (ChatGPT connectors, Claude's custom connectors, hosted agents). Each caller sends their own key; nothing is stored between requests, and local file paths are disabled (pass public URLs). A request without a key is answered `401` with `WWW-Authenticate: Bearer realm="verse-mcp"` and a JSON-RPC error that says what to send.

```json
{
  "mcpServers": {
    "verse": {
      "url": "https://verse.ctruh.com/mcp",
      "headers": { "Authorization": "Bearer paste-your-key" }
    }
  }
}
```

Claude Code: `claude mcp add --transport http verse https://verse.ctruh.com/mcp --header "Authorization: Bearer $VERSE_API_KEY"`.

To host it yourself:

```sh
VERSE_BASE_URL=https://verse.ctruh.com npx @ctruhtech/verse-mcp --http --port 8787   # http://127.0.0.1:8787/mcp
```

Put TLS in front of it. To mount it inside an existing Node server instead:

```js
import { createHttpHandler } from "@ctruhtech/verse-mcp";
const mcp = createHttpHandler({ baseUrl: "https://verse.ctruh.com" });
// in your request listener: if (url.pathname === "/mcp") return mcp(req, res);
```

## Command line

```
verse-mcp                 stdio server
verse-mcp --http [--port 8787] [--host 127.0.0.1] [--allow-anonymous]
verse-mcp --version
```

## Develop

```sh
npm install
npm run typecheck
npm test                  # scripted Verse origin, both transports, driven by the official MCP client
```

Issues and source: <https://github.com/ctruhtech/verse-mcp>. Licence: MIT, see [LICENSE](LICENSE).
