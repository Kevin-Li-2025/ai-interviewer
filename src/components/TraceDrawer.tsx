import type { TraceEvt } from "../lib/sseChat";
import "./TraceDrawer.css";

export default function TraceDrawer({
  open,
  onClose,
  traceId,
  firstTokenMs,
  events,
}: {
  open: boolean;
  onClose: () => void;
  traceId: string | null;
  firstTokenMs: number | null;
  events: TraceEvt[];
}) {
  if (!open) return null;

  const copy = async () => {
    const payload = JSON.stringify({ traceId, firstTokenMs, events }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="trace-overlay" role="dialog" aria-label="延迟追踪">
      <button type="button" className="trace-scrim" onClick={onClose} aria-label="关闭" />
      <div className="trace-panel">
        <div className="trace-head">
          <span>Trace / 延迟分解</span>
          <div className="trace-actions">
            <button type="button" onClick={copy}>
              复制 JSON
            </button>
            <button type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <div className="trace-meta">
          <div>
            <strong>traceId</strong> {traceId ?? "—"}
          </div>
          <div>
            <strong>首 token</strong> {firstTokenMs != null ? `${firstTokenMs} ms` : "—"}
          </div>
        </div>
        <ul className="trace-list">
          {events.length === 0 ? <li className="trace-empty">暂无事件（发起一轮对话后出现）</li> : null}
          {events.map((e, i) => (
            <li key={`${i}-${e.e}`}>
              <code>{e.e}</code>
              {typeof e.ms === "number" ? <span className="trace-ms">{e.ms} ms</span> : null}
              {e.msg ? <span className="trace-msg">{e.msg}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
