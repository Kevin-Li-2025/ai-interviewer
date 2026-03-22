import "dotenv/config";
import cors from "cors";
import express from "express";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
const openaiKey = process.env.OPENAI_API_KEY?.trim();

/** Chat/refine: DeepSeek (OpenAI-compatible) if DEEPSEEK_API_KEY, else OpenAI. */
const llm =
  deepseekKey
    ? new OpenAI({
        apiKey: deepseekKey,
        baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      })
    : openaiKey
      ? new OpenAI({ apiKey: openaiKey })
      : null;

const provider = deepseekKey ? "deepseek" : openaiKey ? "openai" : "none";

/** TTS only works with OpenAI; optional second client. */
const openaiTts =
  openaiKey && process.env.OPENAI_TTS === "1" ? new OpenAI({ apiKey: openaiKey }) : null;

const FAST_MODEL = deepseekKey
  ? process.env.DEEPSEEK_MODEL_FAST || "deepseek-chat"
  : process.env.OPENAI_MODEL_FAST || process.env.OPENAI_MODEL || "gpt-4o-mini";

const SLOW_MODEL = deepseekKey
  ? process.env.DEEPSEEK_MODEL_SLOW || "deepseek-chat"
  : process.env.OPENAI_MODEL_SLOW || "gpt-4o";

const SYSTEM_FAST = `You are a live technical interviewer (fast lane).
Rules:
- Reply in 2–4 very short sentences. Sound spoken, not essay-like.
- One question at a time. Match candidate language (Chinese/English).
- No meta disclaimers.`;

const SYSTEM_SLOW = `You are the "slow thinking" analyst for the same interview (background lane).
Given the recent exchange, output compact JSON only:
{"summary":"1-2 sentences","follow_up":"one sharper optional follow-up question or empty string","rubric":["2-4 bullet strings scoring signals"]}
No markdown, no extra keys.`;

/** @type {Map<string, { created: number, events: object[] }>} */
const traces = new Map();

function appendTrace(traceId, evt) {
  if (!traceId) return;
  let b = traces.get(traceId);
  if (!b) {
    b = { created: Date.now(), events: [] };
    traces.set(traceId, b);
  }
  b.events.push({ t: Date.now(), ...evt });
  if (traces.size > 80) {
    const oldest = [...traces.entries()].sort((a, b) => a[1].created - b[1].created)[0];
    if (oldest) traces.delete(oldest[0]);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(llm),
    provider,
    fastModel: FAST_MODEL,
    slowModel: SLOW_MODEL,
    ttsEnabled: Boolean(openaiTts),
  });
});

app.get("/api/trace/:id", (req, res) => {
  const b = traces.get(req.params.id);
  if (!b) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(b);
});

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

app.post("/api/chat", async (req, res) => {
  if (!llm) {
    res.status(503).json({
      error:
        "Missing LLM API key. Set DEEPSEEK_API_KEY or OPENAI_API_KEY in .env (see .env.example).",
    });
    return;
  }

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages[] required" });
    return;
  }

  const traceId =
    typeof req.body?.traceId === "string" && req.body.traceId.length >= 8
      ? req.body.traceId
      : randomUUID();
  const t0 = Date.now();
  appendTrace(traceId, { e: "request", route: "chat" });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  sseWrite(res, { trace: { e: "trace_id", id: traceId } });

  let first = true;
  try {
    const stream = await llm.chat.completions.create({
      model: FAST_MODEL,
      stream: true,
      messages: [{ role: "system", content: SYSTEM_FAST }, ...messages],
      temperature: 0.55,
      max_tokens: 380,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? "";
      if (text) {
        if (first) {
          first = false;
          const ms = Date.now() - t0;
          appendTrace(traceId, { e: "llm_fast_first_token", ms });
          sseWrite(res, { trace: { e: "llm_fast_first_token", ms } });
        }
        sseWrite(res, { t: text });
      }
    }
    appendTrace(traceId, { e: "llm_fast_done", ms: Date.now() - t0 });
    sseWrite(res, { trace: { e: "llm_fast_done", ms: Date.now() - t0 } });
    sseWrite(res, { done: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "stream error";
    appendTrace(traceId, { e: "error", msg });
    sseWrite(res, { error: msg });
  } finally {
    res.end();
  }
});

app.post("/api/refine", async (req, res) => {
  if (!llm) {
    res.status(503).json({ error: "Missing DEEPSEEK_API_KEY or OPENAI_API_KEY" });
    return;
  }
  const messages = req.body?.messages;
  const fastReply = req.body?.fastReply;
  const traceId = typeof req.body?.traceId === "string" ? req.body.traceId : null;
  if (!Array.isArray(messages) || typeof fastReply !== "string") {
    res.status(400).json({ error: "messages[] and fastReply required" });
    return;
  }

  const t0 = Date.now();
  appendTrace(traceId, { e: "refine_start" });

  const tail = messages.slice(-8);
  const refineMessages = [
    { role: "system", content: SYSTEM_SLOW },
    ...tail,
    {
      role: "user",
      content: `Fast interviewer just said (verbatim):\n"""${fastReply}"""\nReturn JSON as instructed.`,
    },
  ];
  try {
    let completion;
    try {
      completion = await llm.chat.completions.create({
        model: SLOW_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.35,
        max_tokens: 450,
        messages: refineMessages,
      });
    } catch {
      completion = await llm.chat.completions.create({
        model: SLOW_MODEL,
        temperature: 0.35,
        max_tokens: 450,
        messages: refineMessages,
      });
    }
    const raw = completion.choices[0]?.message?.content?.trim() ?? "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { summary: raw, follow_up: "", rubric: [] };
    }
    const ms = Date.now() - t0;
    appendTrace(traceId, { e: "refine_done", ms });
    res.json({ ok: true, refine: parsed, ms, traceId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "refine error";
    appendTrace(traceId, { e: "refine_error", msg });
    res.status(500).json({ error: msg, traceId });
  }
});

app.post("/api/tts", async (req, res) => {
  if (!openaiTts) {
    res.status(503).json({
      error: "TTS requires OPENAI_API_KEY and OPENAI_TTS=1 (DeepSeek has no speech API here).",
    });
    return;
  }
  const text = req.body?.text;
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text required" });
    return;
  }
  const traceId = typeof req.body?.traceId === "string" ? req.body.traceId : null;
  const t0 = Date.now();
  appendTrace(traceId, { e: "tts_chunk_start", len: text.length });
  try {
    const response = await openaiTts.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || "tts-1",
      voice: process.env.OPENAI_TTS_VOICE || "alloy",
      input: text.slice(0, 1200),
      response_format: "mp3",
    });
    const blob = await response.blob();
    const buf = Buffer.from(await blob.arrayBuffer());
    appendTrace(traceId, { e: "tts_chunk_done", ms: Date.now() - t0, bytes: buf.length });
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "tts error";
    appendTrace(traceId, { e: "tts_error", msg });
    res.status(500).json({ error: msg });
  }
});

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => {
  console.log(
    `AI interviewer API http://127.0.0.1:${port} [${provider}] fast=${FAST_MODEL} slow=${SLOW_MODEL}`
  );
});
