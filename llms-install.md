# Install Verse MCP

Verse Engine publishes 3D scenes, walkthroughs and worlds, from a single product to a whole city, as links that open in any browser.

## Remote (recommended)

Add a Streamable HTTP MCP server named `verse` with the URL `https://verse.ctruh.com/mcp`. When the client asks, sign in with a Verse account (free at https://verse.ctruh.com) and press Allow. No API key is needed.

## Local (stdio)

Add a stdio server:

- command: `npx`
- args: `["-y", "@ctruhtech/verse-mcp"]`
- env: `VERSE_API_KEY` set to a key from the Verse Account page (API keys card)

Requires Node 20 or newer.

## Check it works

Ask: "List my Verse scenes." Then: "Publish https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/SheenChair/glTF-Binary/SheenChair.glb on Verse and give me the link."
