/**
 * Nightly-style smoke: 50 synthetic interview prompts → /api/chat SSE,
 * records wall time and server-reported llm_fast_first_token when present.
 *
 * Usage: start API (`npm run server`), set DEEPSEEK_API_KEY or OPENAI_API_KEY, then:
 *   npm run eval
 *
 * Optional: EVAL_BASE=http://127.0.0.1:8787
 */
import { randomUUID } from "node:crypto";

const BASE = process.env.EVAL_BASE ?? "http://127.0.0.1:8787";

const prompts = Array.from({ length: 50 }, (_, i) => {
  const n = i + 1;
  return `[场景 ${n}/50] 你是面试官。用中文提出一个简短的行为或技术问题（一句问句即可），针对软件工程师岗位。不要复述本说明。`;
});

async function runOne(prompt) {
  const traceId = randomUUID();
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      traceId,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const body = res.body;
  if (!body) throw new Error("no body");
  const reader = body.getReader();

  const dec = new TextDecoder();
  let buf = "";
  let firstReported = null;
  let tokenChars = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(payload);
      } catch {
        continue;
      }
      if (j.error) throw new Error(j.error);
      if (j.trace?.e === "llm_fast_first_token" && typeof j.trace.ms === "number") firstReported = j.trace.ms;
      if (typeof j.t === "string") tokenChars += j.t.length;
    }
  }

  const wall = Date.now() - t0;
  return { wall, firstReported, tokenChars, traceId };
}

async function main() {
  console.log(`Eval → ${BASE} (${prompts.length} prompts)\n`);
  const rows = [];
  for (let i = 0; i < prompts.length; i++) {
    process.stdout.write(`\rRunning ${i + 1}/${prompts.length}…`);
    try {
      rows.push(await runOne(prompts[i]));
    } catch (e) {
      console.error(`\nFail at ${i + 1}:`, e.message);
      process.exitCode = 1;
      return;
    }
  }
  console.log("\n");

  const walls = rows.map((r) => r.wall).sort((a, b) => a - b);
  const firsts = rows.map((r) => r.firstReported).filter((x) => x != null);
  const p95 = (arr) => arr[Math.floor(0.95 * (arr.length - 1))] ?? arr[arr.length - 1];

  console.log("Wall time (ms): min", walls[0], "p50", walls[Math.floor(walls.length / 2)], "p95", p95(walls), "max", walls[walls.length - 1]);
  if (firsts.length) {
    const s = [...firsts].sort((a, b) => a - b);
    console.log("Server llm_fast_first_token (ms): min", s[0], "p50", s[Math.floor(s.length / 2)], "p95", p95(s), "max", s[s.length - 1]);
  }
  console.log("Avg output chars:", Math.round(rows.reduce((a, r) => a + r.tokenChars, 0) / rows.length));
}

main();
