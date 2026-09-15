// MCP-сервер, который даёт Claude инструмент "generate_image".
// Генерация идёт через Pollinations.ai (модель Flux) — бесплатно,
// без API-ключа и без общего лимита запросов.
//
// Запускается как обычный веб-сервер (Express) и слушает порт из
// переменной окружения PORT.
//
// Никаких переменных окружения задавать не нужно.

const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

async function generateImage(prompt) {
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux&width=1024&height=1024&nologo=true&seed=${seed}`;

  const resp = await fetch(url);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `Pollinations.ai вернул ошибку ${resp.status}: ${errText}`
    );
  }

  const arrayBuffer = await resp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mimeType = resp.headers.get("content-type") || "image/jpeg";

  return { mimeType, base64 };
}

function buildServer() {
  const server = new McpServer({
    name: "pollinations-image-generator",
    version: "1.0.0",
  });

  server.registerTool(
    "generate_image",
    {
      title: "Сгенерировать изображение (Pollinations.ai)",
      description:
        "Генерирует изображение по текстовому описанию с помощью Pollinations.ai (модель Flux). Бесплатно, без ключа.",
      inputSchema: {
        prompt: z
          .string()
          .describe(
            "Подробное описание картинки, лучше на английском для лучшего качества"
          ),
      },
    },
    async ({ prompt }) => {
      const img = await generateImage(prompt);
      return {
        content: [
          {
            type: "image",
            data: img.base64,
            mimeType: img.mimeType,
          },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Внутренняя ошибка сервера" },
        id: null,
      });
    }
  }
});

app.get("/", (req, res) => {
  res.send(
    "Pollinations MCP-сервер работает. MCP-эндпоинт: /mcp. Ключи не нужны."
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pollinations MCP-сервер запущен на порту ${PORT}`);
});
