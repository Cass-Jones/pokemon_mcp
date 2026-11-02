# Build and Deploy a Pokémon MCP Server

A hands-on team guide to building a small Model Context Protocol (MCP) server, testing it locally, and deploying it to Render.

**Outcome:** An MCP-compatible AI application can call your `get_pokemon` tool to retrieve Pokémon data from PokéAPI.

## Deployed server

- **MCP connection URL:** `https://pokemon-mcp.onrender.com/mcp`
- **Health check:** <https://pokemon-mcp.onrender.com/health>
- **Transport:** Streamable HTTP
- **Authentication:** None for this public, read-only demo.

When adding this server to watsonx Orchestrate, use the full URL ending in **`/mcp`**. The root URL (`https://pokemon-mcp.onrender.com`) is not the MCP endpoint and returns 404 for initialization requests. The deployed `/mcp` endpoint successfully answered a diagnostic initialization request; the team also confirmed its Orchestrate connection after correcting the URL.

To run this existing repository locally, clone it, run `npm ci`, and then run `npm start`. Follow steps 7–8 below to verify it. The full tutorial that follows explains how to build the project from scratch; use a separate folder if following those setup steps.

**Stack:** JavaScript, Node.js 24, MCP JavaScript/TypeScript SDK v2, Express, Zod, GitHub, and Render.

**Validation note:** This example was checked against the linked documentation when the guide was prepared, but has not been executed or deployed by the guide's author. Follow the verification steps before sharing your deployment.

## 1. Understand what you are building

```text
You: “What type is Pikachu?”
          ↓
AI application (MCP host)
          ↓
MCP client inside that application
          ↓
Your MCP server → PokéAPI
          ↑
Pokémon data → assistant’s answer
```

| Component | Responsibility |
| --- | --- |
| AI application, or host | Runs the assistant and manages tool access |
| MCP client | Communicates with the server using MCP |
| Your MCP server | Describes tools and executes them |
| PokéAPI | Supplies Pokémon data |

Your server does not need an AI model or an OpenAI API key. It exposes a tool that an AI application can discover and call:

```text
get_pokemon(name_or_id)
```

Example arguments:

```json
{"name_or_id": "pikachu"}
```

MCP can also expose resources and reusable prompts. This exercise starts with one tool so you can focus on discovery, validation, execution, and transport.

Reference: [MCP SDK v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/).

## 2. Install the prerequisites

Each participant needs:

- [Node.js](https://nodejs.org/en/download), version 24 LTS for this guide.
- [Git](https://git-scm.com/downloads).
- A code editor, such as [Visual Studio Code](https://code.visualstudio.com/).
- GitHub and Render accounts for deployment.

The commands below use PowerShell on Windows. Open a new terminal after installing the tools, then run:

```powershell
node --version
npm --version
git --version
```

**Why:** Node runs the server, npm installs libraries, and Git tracks the files you will deploy.

**Checkpoint:** All three commands print version numbers.

## 3. Try PokéAPI directly

```powershell
$pokemon = Invoke-RestMethod "https://pokeapi.co/api/v2/pokemon/pikachu"
$pokemon.name
$pokemon.types.type.name
```

Expected values: `pikachu` and `electric`.

PokéAPI accepts Pokémon names and IDs and requires no authentication. Its fair-use policy asks developers to cache requested resources; the implementation below includes a small cache.

**Why:** Calling a web API is separate from exposing that operation through MCP. Testing the underlying API first makes troubleshooting easier.

Reference: [PokéAPI documentation and fair-use policy](https://pokeapi.co/docs/v2).

## 4. Create the project

Run these commands from the parent folder where you want to keep the project:

```powershell
mkdir pokemon-mcp
cd pokemon-mcp
npm init -y
npm pkg set type=module
npm pkg set "scripts.start=node server.js"
npm pkg set "engines.node=24.x"
npm install @modelcontextprotocol/server@2 @modelcontextprotocol/express@2 @modelcontextprotocol/node@2 express@5 zod@4
```

| Package | Purpose |
| --- | --- |
| `@modelcontextprotocol/server` | Defines MCP servers and tools |
| `@modelcontextprotocol/express` | Provides MCP-friendly Express setup |
| `@modelcontextprotocol/node` | Connects the HTTP handler to Node |
| `express` | Runs the web server |
| `zod` | Validates tool arguments |

`type=module` enables JavaScript `import` syntax. The `@2` versions keep this project on the SDK v2 API. Keep the generated `package-lock.json`; deployment uses it to install the same resolved dependency versions.

## 5. Write the Pokémon lookup function

Create `pokemon.js` in the project folder:

```javascript
// Shared across requests while this process is running.
const cache = new Map();
const CACHE_LIMIT = 500;

export async function getPokemon(nameOrId) {
  const key = nameOrId.trim().toLowerCase();

  if (!/^[a-z0-9-]{1,100}$/.test(key)) {
    throw new Error(
      "Use a Pokémon name or ID, such as pikachu, mr-mime, or 25."
    );
  }

  if (cache.has(key)) {
    return cache.get(key);
  }

  const response = await fetch(
    `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(key)}`,
    { signal: AbortSignal.timeout(10000) }
  );

  if (response.status === 404) {
    throw new Error(`No Pokémon found for "${key}".`);
  }

  if (!response.ok) {
    throw new Error(`PokéAPI returned HTTP ${response.status}.`);
  }

  const pokemon = await response.json();

  const result = {
    id: pokemon.id,
    name: pokemon.name,
    types: pokemon.types.map((entry) => entry.type.name),
    height_m: pokemon.height / 10,
    weight_kg: pokemon.weight / 10,
    abilities: pokemon.abilities.map((entry) => entry.ability.name),
    base_stats: Object.fromEntries(
      pokemon.stats.map((entry) => [
        entry.stat.name,
        entry.base_stat,
      ])
    ),
  };

  // Bound memory use by removing the oldest cached entry.
  if (cache.size >= CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }

  cache.set(key, result);
  return result;
}
```

This function:

- Normalizes `Pikachu` to `pikachu`.
- Restricts inputs to API-style names and IDs.
- Stops waiting after ten seconds.
- Converts height and weight to meters and kilograms.
- Returns a compact summary.
- Caches successful lookups and limits the cache to 500 entries.

**Why:** This is ordinary application logic. Keeping it separate makes the MCP layer easier to understand and lets you reuse the lookup elsewhere.

The cache resets when the process restarts and is not shared between server instances. A larger deployment could use a shared persistent cache.

## 6. Expose the function as an MCP tool

Create `server.js` in the same folder:

```javascript
import { McpServer, createMcpHandler }
  from "@modelcontextprotocol/server";
import { createMcpExpressApp }
  from "@modelcontextprotocol/express";
import { toNodeHandler }
  from "@modelcontextprotocol/node";
import * as z from "zod/v4";

import { getPokemon } from "./pokemon.js";

function createServer() {
  const server = new McpServer({
    name: "pokemon-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "get_pokemon",
    {
      description:
        "Look up a Pokémon by name or numeric ID. Returns types, " +
        "size, abilities, and base stats. Use API-style names " +
        "such as pikachu or mr-mime.",
      inputSchema: z.object({
        name_or_id: z.string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9-]+$/)
          .describe("A Pokémon name or ID, such as pikachu or 25"),
      }),
    },
    async ({ name_or_id }) => {
      try {
        const pokemon = await getPokemon(name_or_id);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(pokemon, null, 2),
          }],
        };
      } catch (error) {
        console.error("Pokémon lookup failed:", error);

        return {
          isError: true,
          content: [{
            type: "text",
            text: error instanceof Error
              ? error.message
              : "The Pokémon lookup failed.",
          }],
        };
      }
    }
  );

  return server;
}

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);

const allowedHosts = (
  process.env.ALLOWED_HOSTS || "localhost,127.0.0.1"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const app = createMcpExpressApp({ host, allowedHosts });

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

const handler = toNodeHandler(createMcpHandler(createServer));

app.all("/mcp", (request, response) => {
  void handler(request, response, request.body).catch((error) => {
    console.error("MCP request failed:", error);

    if (!response.headersSent) {
      response.status(500).json({ error: "Internal server error" });
    } else {
      response.end();
    }
  });
});

app.listen(port, host, () => {
  console.error(`Pokémon MCP server: http://${host}:${port}/mcp`);
});
```

### How the MCP layer works

1. **Identity:** `McpServer` gives the server a name and version.
2. **Discovery:** `registerTool` publishes the tool name, description, and input schema.
3. **Validation:** Zod checks arguments before the tool handler runs.
4. **Execution:** The handler calls `getPokemon` and wraps the result in MCP content.
5. **Errors:** `isError: true` tells the client the tool execution failed.
6. **Transport:** `/mcp` receives protocol messages over HTTP.

The tool description helps an assistant choose the tool. The schema tells it which arguments to send.

This implementation uses Streamable HTTP and creates a fresh MCP server per request. No database or in-memory client session is needed. The lookup cache lives outside the server factory so it survives across requests within a running process.

The Express helper provides request parsing and host/origin protections. `allowedHosts` specifies the hostnames your service accepts; it is not user authentication.

Reference: [SDK Express integration](https://ts.sdk.modelcontextprotocol.io/v2/serving/express.html).

## 7. Start the server locally

From the project folder:

```powershell
npm start
```

Leave that terminal running. In a second terminal:

```powershell
Invoke-RestMethod "http://127.0.0.1:3000/health"
```

Expected result:

```text
status
------
ok
```

**Why:** This proves the web server is listening. It does not yet prove that MCP or the Pokémon lookup works.

Opening `/mcp` in a normal browser is not a complete MCP test. An MCP client sends protocol messages rather than simply loading a webpage.

## 8. Test MCP with the Inspector

In the second terminal, run:

```powershell
npx @modelcontextprotocol/inspector
```

Open the local URL it prints, then:

1. Select **Streamable HTTP** as the transport.
2. Enter `http://127.0.0.1:3000/mcp`.
3. Connect.
4. Open the tools view and list the available tools.
5. Select `get_pokemon`.
6. Enter `pikachu` for `name_or_id`.
7. Run the tool.

The Inspector is an MCP testing client. It lets you test the server without an AI model.

| Input | Expected behavior |
| --- | --- |
| `pikachu` | Returns Pikachu, including electric type |
| `25` | Returns Pikachu by ID |
| `charizard` | Returns fire and flying types |
| `not-a-real-pokemon` | Returns a tool error explaining no Pokémon was found |
| `../../something` | Fails input validation |

**Checkpoint:** Tool discovery, successful execution, missing-Pokémon handling, and validation all work.

Reference: [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector).

## 9. Understand the protocol exchange

Conceptually, the client establishes communication and negotiates capabilities, discovers available tools, calls a tool with arguments, and receives the result. The SDK handles protocol negotiation and message formatting.

A tool call looks roughly like this:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_pokemon",
    "arguments": {
      "name_or_id": "pikachu"
    }
  }
}
```

You do not need to manually send this message for the exercise; the Inspector does that for you.

**What MCP adds:** A standard way for clients to discover your operation, understand its inputs, and execute it. PokéAPI itself remains a regular HTTP API.

## 10. Prepare the project for deployment

Create `.gitignore`:

```gitignore
node_modules/
.env
*.log
```

The project should contain:

```text
pokemon-mcp/
  .gitignore
  package.json
  package-lock.json
  pokemon.js
  server.js
```

From the project folder, save it in Git:

```powershell
git init
git add .
git commit -m "Build basic Pokemon MCP server"
git branch -M main
```

If Git asks for your identity, follow its instructions to configure your name and email, then retry the commit.

On GitHub, create an **empty** repository named `pokemon-mcp`. Do not initialize it with another README or other files. Then replace `YOUR-USERNAME` and run:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/pokemon-mcp.git
git push -u origin main
```

**Why:** Render will download this repository and run your application. Commit the lockfile, but do not commit `node_modules`.

## 11. Deploy to Render

In the [Render dashboard](https://dashboard.render.com/):

1. Choose **New → Web Service**.
2. Connect the GitHub repository.
3. Select the Node runtime and the `main` branch.
4. Configure the following settings.

| Setting | Value |
| --- | --- |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/health` |

Add these environment variables in Render:

| Variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `ALLOWED_HOSTS` | Your assigned hostname, such as `pokemon-mcp-abc.onrender.com` |

Use the actual hostname, without `https://` or a path. If Render supplies it only after service creation, update `ALLOWED_HOSTS` and redeploy. Let Render supply `PORT`.

Choose a plan after reviewing the displayed price and limits, then deploy.

**Why these settings matter:**

- `npm ci` installs the dependency versions recorded in the lockfile.
- `npm start` launches the application.
- `0.0.0.0` allows Render's routing to reach the process.
- `PORT` tells the process which port Render expects.
- `ALLOWED_HOSTS` admits requests using the service's public hostname.
- `/health` gives the platform a simple readiness check.

This learning server has no authentication and exposes only public, read-only Pokémon data. Anyone who knows its URL can call it. Before expanding it into a broader service, add appropriate authentication and request limits.

References: [Deploy a Node Express app](https://render.com/docs/deploy-node-express-app), [Render web service networking](https://render.com/docs/web-services).

## 12. Verify the deployed server

Replace the placeholder with your service hostname and open:

```text
https://YOUR-SERVICE.onrender.com/health
```

Expected response:

```json
{"status":"ok"}
```

Next, connect the Inspector to:

```text
https://YOUR-SERVICE.onrender.com/mcp
```

Use Streamable HTTP and repeat the test cases from step 8.

**Checkpoint:** The hosted service lists `get_pokemon`, returns Pokémon data, and handles invalid or missing Pokémon correctly through its public address.

## 13. Connect an AI application

Use an MCP-compatible application that supports remote Streamable HTTP servers:

1. Add a remote MCP server in the application's configuration.
2. Enter the deployed `/mcp` URL.
3. Enable the `get_pokemon` tool.
4. Ask: “Use the Pokémon tool to tell me Pikachu's type and base speed.”

The exact configuration screen depends on the application. Consult its MCP documentation if it requires a configuration file instead of a settings screen.

Check the application's tool activity to confirm it called `get_pokemon`. The assistant may already know Pokémon facts, so a correct answer alone does not prove the integration works.

## 14. Make and deploy your first update

Add this field to the `result` object in `pokemon.js`, beside `id` and `name`:

```javascript
base_experience: pokemon.base_experience,
```

Then:

1. Stop the local server with `Ctrl+C` and run `npm start` again.
2. Test the tool locally in the Inspector and confirm the new field appears.
3. Commit and push the change:

```powershell
git add pokemon.js
git commit -m "Include Pokemon base experience"
git push
```

4. If automatic deployment is enabled, wait for Render to deploy the commit. Otherwise trigger a deployment from the dashboard.
5. Call the hosted tool again and confirm the new field appears.

**Why:** This completes the development loop: edit, verify locally, commit, deploy, and verify remotely.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `node`, `npm`, or `git` not found | Install the prerequisite and open a new terminal |
| PowerShell blocks `npm.ps1` or `npx.ps1` | Use `npm.cmd` or `npx.cmd` in the same commands |
| Local connection refused | Confirm `npm start` is running and the address and port match |
| Port already in use | Stop the other process, or set `$env:PORT = "3001"` before starting and use that port in the Inspector |
| HTTP 403 | Check `ALLOWED_HOSTS` against the hostname used in the URL |
| Health works, tool fails | Read the server logs and check connectivity to PokéAPI |
| Tool does not appear | Confirm the URL ends in `/mcp` and the transport is Streamable HTTP |
| Assistant answers without using the tool | Explicitly request the tool and inspect tool activity |
| Missing package export or import error | Confirm you installed the SDK v2 packages listed in step 4 |
| Deployed service is unreachable | Check deployment logs, `HOST=0.0.0.0`, and use of Render's `PORT` |
| Render build rejects the lockfile | Run `npm install` locally, verify the result, and commit both package files |

## Team completion checklist

- [ ] Explain the roles of host, client, server, and upstream API.
- [ ] Call PokéAPI directly.
- [ ] Start the local server and check `/health`.
- [ ] Discover and call `get_pokemon` in the Inspector.
- [ ] Verify successful lookups and error handling.
- [ ] Push the project to GitHub.
- [ ] Deploy it to Render.
- [ ] Verify the hosted tool in the Inspector.
- [ ] Observe an AI application calling the tool.
- [ ] Deploy and verify the `base_experience` update.

## Optional follow-up exercise

Add a second tool, `get_type_matchups`, using PokéAPI's type endpoint. Then ask the assistant a question that requires both tools, such as looking up a Pokémon's types and explaining their defensive matchups.

This helps you observe how an assistant selects tools and combines their results. When implementing dual-type matchups, combine the damage multipliers from both types rather than treating their weaknesses as a simple list.
