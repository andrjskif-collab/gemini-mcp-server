// MCP-сервер, который даёт Claude инструмент "generate_image",
// внутри вызывающий Gemini API для генерации картинок.
//
// Запускается как обычный веб-сервер (Express) и слушает порт из
// переменной окружения PORT (bothost.ru сам её задаёт).
//
// Требуется переменная окружения GEMINI_API_KEY — ваш бесплатный
// ключ с https://aistudio.google.com/apikey

const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Модель для генерации изображений. Если Google переименует модель,
// поменяйте значение тут или через переменную окружения GEMINI_IMAGE_MODEL.
// Актуальное имя всегда можно проверить на https://ai.google.dev/gemini-api/docs/image-generation
const GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

if (!GEMINI_API_KEY) {
  console.error("ОШИБКА: не задана переменная окружения GEMINI_API_KEY");
}

async function generateImage(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API вернул ошибку ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData);

  if (!imagePart) {
    const textPart = parts.find((p) => p.text);
    throw new Error(
      "Gemini не вернул изображение. Ответ модели: " +
        (textPart?.text || JSON.stringify(data))
    );
  }

  return {
    mimeType: imagePart.inlineData.mimeType || "image/png",
    base64: imagePart.inlineData.data,
  };
}

function buildServer() {
  const server = new McpServer({
    name: "gemini-image-generator",
    version: "1.0.0",
  });

  server.registerTool(
    "generate_image",
    {
      title: "Сгенерировать изображение через Gemini",
      description:
        "Генерирует изображение по текстовому описанию с помощью Gemini (Nano Banana).",
      inputSchema: {
        prompt: z
          .string()
          .describe("Подробное описание картинки на русском или английском"),
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

// Один MCP-эндпоинт, без сохранения состояния между запросами —
// самый простой и надёжный вариант для хостинга вроде bothost.ru.
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
  res.send("Gemini MCP-сервер работает. MCP-эндпоинт: /mcp");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gemini MCP-сервер запущен на порту ${PORT}`);
});
