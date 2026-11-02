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