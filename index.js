// MCP-сервер с инструментом "generate_image".
// Пробует три сервиса по очереди (лучшее качество -> надёжный запасной):
//   1. Hugging Face (модель FLUX.1-schnell) — нужен бесплатный токен HF_TOKEN
//   2. OVHcloud AI Endpoints (Stable Diffusion XL) — без ключа, лимит 2 запроса/мин
//   3. Pollinations.ai (Flux) — без ключа, без общего лимита, запасной вариант
//
// Переменные окружения:
//   HF_TOKEN — обязателен для шага 1 (если не задан, шаг 1 просто пропускается)

const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const HF_TOKEN = process.env.HF_TOKEN || "";

function bufferToBase64(buf) {
  return Buffer.from(buf).toString("base64");
}

// --- Уровень 1: Hugging Face (Flux) ---
async function tryHuggingFace(prompt) {
  if (!HF_TOKEN) {
    throw new Error("HF_TOKEN не задан, пропускаем Hugging Face");
  }

  const resp = await fetch(
    "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: prompt }),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Hugging Face вернул ошибку ${resp.status}: ${errText}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    // Модель ещё "прогревается" или вернула JSON с ошибкой/оценкой времени
    const text = await resp.text().catch(() => "");
    throw new Error(`Hugging Face не вернул изображение: ${text}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return { mimeType: contentType, base64: bufferToBase64(arrayBuffer) };
}

// --- Уровень 2: OVHcloud AI Endpoints (Stable Diffusion XL) ---
async function tryOVHcloud(prompt) {
  const resp = await fetch(
    "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/images/generations",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ",
      },
      body: JSON.stringify({
        model: "stable-diffusion-xl-base-v10",
        prompt: prompt,
        size: "1024x1024",
      }),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OVHcloud вернул ошибку ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OVHcloud не вернул b64_json: " + JSON.stringify(data));
  }

  return { mimeType: "image/png", base64: b64 };
}

// --- Уровень 3: Pollinations.ai (запасной, всегда отвечает) ---
async function tryPollinations(prompt) {
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux&width=1024&height=1024&nologo=true&seed=${seed}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Pollinations вернул ошибку ${resp.status}: ${errText}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const mimeType = resp.headers.get("content-type") || "image/jpeg";
  return { mimeType, base64: bufferToBase64(arrayBuffer) };
}

async function generateImage(prompt) {
  const attempts = [
    { name: "Hugging Face (Flux)", fn: tryHuggingFace },
    { name: "OVHcloud (SDXL)", fn: tryOVHcloud },
    { name: "Pollinations (Flux)", fn: tryPollinations },
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const result = await attempt.fn(prompt);
      console.log(`Успех через: ${attempt.name}`);
      return { ...result, usedService: attempt.name };
    } catch (err) {
      console.log(`${attempt.name} не сработал: ${err.message}`);
      errors.push(`${attempt.name}: ${err.message}`);
    }
  }

  throw new Error(
    "Все сервисы генерации недоступны:\n" + errors.join("\n")
  );
}

function buildServer() {
  const server = new McpServer({
    name: "multi-image-generator",
    version: "1.0.0",
  });

  server.registerTool(
    "generate_image",
    {
      title: "Сгенерировать изображение",
      description:
        "Генерирует изображение по текстовому описанию. Пробует Hugging Face (Flux), затем OVHcloud (SDXL), затем Pollinations как запасной вариант.",
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
    "Multi-image MCP-сервер работает. MCP-эндпоинт: /mcp. Уровни: Hugging Face -> OVHcloud -> Pollinations."
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Multi-image MCP-сервер запущен на порту ${PORT}`);
  console.log(HF_TOKEN ? "HF_TOKEN задан — Hugging Face доступен" : "HF_TOKEN НЕ задан — Hugging Face будет пропускаться");
});
