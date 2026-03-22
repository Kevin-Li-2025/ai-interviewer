export type TraceEvt = { e: string; ms?: number; id?: string; msg?: string; len?: number; bytes?: number };

export async function readSseChat(
  res: Response,
  opts: {
    signal?: AbortSignal;
    onToken: (s: string) => void;
    onTrace?: (evt: TraceEvt) => void;
    onTraceId?: (id: string) => void;
  }
): Promise<void> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || res.statusText);
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

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
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof j.error === "string") throw new Error(j.error);
      if (j.trace && typeof j.trace === "object") {
        const tr = j.trace as TraceEvt;
        opts.onTrace?.(tr);
        if (tr.e === "trace_id" && tr.id) opts.onTraceId?.(tr.id);
      }
      if (typeof j.t === "string") opts.onToken(j.t);
      if (j.done === true) return;
    }
  }
}
