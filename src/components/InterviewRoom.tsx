import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatClock, randomMeetingCode } from "../lib/meeting";
import { useHybridInterview } from "../hooks/useHybridInterview";
import { useAudioVad } from "../hooks/useAudioVad";
import { IconCam, IconChat, IconMic, IconPeople, IconPhoneDown } from "./Icons";
import TraceDrawer from "./TraceDrawer";
import type { SessionState } from "../hooks/useHybridInterview";
import "./InterviewRoom.css";

const STATE_LABEL: Record<SessionState, string> = {
  idle: "待机",
  connecting: "连接中",
  listening: "聆听",
  thinking: "快轨思考",
  speaking: "输出语音",
  recovering: "恢复中",
};

function stateHint(s: SessionState): string {
  switch (s) {
    case "listening":
      return "可说话；AI 说话时出声即可打断";
    case "thinking":
      return "小模型流式应答，大模型在后台总结";
    case "speaking":
      return "分句播放 + 预缓冲，降低卡顿感";
    default:
      return "混合架构：快答 / 慢想 双轨";
  }
}

export default function InterviewRoom() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camOn, setCamOn] = useState(true);
  const [started, setStarted] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [textReply, setTextReply] = useState("");
  const meetingCode = useMemo(() => randomMeetingCode(), []);

  const { speechActive } = useAudioVad(micStream);

  const {
    liveUser,
    liveAi,
    listening,
    aiSpeaking,
    sessionState,
    busy,
    error,
    apiReady,
    beginInterview,
    toggleMic,
    stopListening,
    startListening,
    sendUserText,
    messages,
    slowInsight,
    traceLog,
    traceId,
    firstTokenMs,
    useOpenAiTts,
  } = useHybridInterview({ speechActive, sessionActive: started });

  const lastAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].content;
    }
    return "";
  }, [messages]);

  const caption = liveAi || lastAssistant;

  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "`" && !e.metaKey && !e.ctrlKey) setTraceOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    if (!started || !listening) {
      setMicStream(null);
      return () => {
        cancelled = true;
        stream?.getTracks().forEach((tr) => tr.stop());
      };
    }

    void (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (cancelled) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream = s;
        setMicStream(s);
      } catch {
        if (!cancelled) setMicStream(null);
      }
    })();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((tr) => tr.stop());
      setMicStream(null);
    };
  }, [started, listening]);

  const bindCamera = useCallback(async () => {
    if (!camOn) {
      const v = videoRef.current;
      if (v?.srcObject) {
        const tracks = (v.srcObject as MediaStream).getTracks();
        tracks.forEach((tr) => tr.stop());
        v.srcObject = null;
      }
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      const v = videoRef.current;
      if (v) v.srcObject = stream;
    } catch {
      setCamOn(false);
    }
  }, [camOn]);

  useEffect(() => {
    void bindCamera();
  }, [bindCamera]);

  const primeMicPermission = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((tr) => tr.stop());
    } catch {
      /* 仍尝试启动语音识别，由具体错误提示 */
    }
  }, []);

  const onStart = async () => {
    setStarted(true);
    await primeMicPermission();
    await beginInterview();
    startListening();
  };

  const onStartInterviewInRoom = async () => {
    await primeMicPermission();
    if (!listening) startListening();
    await beginInterview();
  };

  const onLeave = () => {
    stopListening();
    setMicStream(null);
    setStarted(false);
    const v = videoRef.current;
    if (v?.srcObject) {
      (v.srcObject as MediaStream).getTracks().forEach((tr) => tr.stop());
      v.srcObject = null;
    }
  };

  const listeningGlow = started && sessionState === "listening";

  const submitTextReply = () => {
    const t = textReply.trim();
    if (!t || busy) return;
    setTextReply("");
    void sendUserText(t);
  };

  return (
    <div className="room">
      <div className={`video-wrap ${listeningGlow ? "listening-glow" : ""}`}>
        {camOn ? (
          <video ref={videoRef} autoPlay playsInline muted />
        ) : (
          <div className="video-placeholder">摄像头已关闭</div>
        )}
      </div>

      <div className="state-pill-wrap">
        <div className="state-pill" title={stateHint(sessionState)}>
          <span className={`state-dot state-${sessionState}`} />
          {STATE_LABEL[sessionState]}
          {firstTokenMs != null ? <span className="state-ttft">{firstTokenMs}ms 首 token</span> : null}
        </div>
        {started && !listening && !busy && sessionState !== "speaking" && sessionState !== "thinking" ? (
          <div className="mic-hint">未开启麦克风识别 — 请点击下方麦克风图标（无斜杠）后再说话</div>
        ) : null}
      </div>

      <div className={`ai-pip ${aiSpeaking ? "ai-speaking" : ""}`}>
        <div className="ai-pip-inner">
          <div className="ai-avatar">AI</div>
          <div className="ai-meta">
            <div className="ai-name-row">
              <span className="ai-name">面试官</span>
              {useOpenAiTts ? <span className="ai-badge">OpenAI TTS</span> : <span className="ai-badge ai-badge-ghost">本地分句朗读</span>}
            </div>
            <div className="ai-caption">
              {sessionState === "thinking" && !liveAi ? <span className="shimmer-text">正在组织语言…</span> : null}
              {started && messages.length === 0 && sessionState !== "connecting" && !busy ? (
                <button type="button" className="ai-start-inline" onClick={() => void onStartInterviewInRoom()}>
                  点击开始 AI 面试
                </button>
              ) : caption ? (
                <>
                  {caption}
                </>
              ) : sessionState === "connecting" ? (
                <span className="shimmer-text">正在建立快轨…</span>
              ) : (
                <span>等待开始面试</span>
              )}
            </div>
            {slowInsight ? (
              <div className="ai-slow" title="慢轨（大模型）后台总结">
                {slowInsight}
              </div>
            ) : null}
            {listening && liveUser ? <div className="user-live">你：{liveUser}</div> : null}
            {started && messages.length > 0 ? (
              <div className="text-reply">
                <label className="text-reply-label" htmlFor="text-reply-input">
                  文字回答（不依赖 Google 语音）
                </label>
                <div className="text-reply-row">
                  <input
                    id="text-reply-input"
                    type="text"
                    className="text-reply-input"
                    placeholder="输入回答后回车或点发送"
                    value={textReply}
                    disabled={busy}
                    onChange={(e) => setTextReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submitTextReply();
                      }
                    }}
                  />
                  <button type="button" className="text-reply-send" disabled={busy || !textReply.trim()} onClick={submitTextReply}>
                    发送
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {apiReady === false ? (
        <div className="banner">
          未检测到 <code>DEEPSEEK_API_KEY</code> 或 <code>OPENAI_API_KEY</code>。请在项目根目录复制{" "}
          <code>.env.example</code> 为 <code>.env</code> 并填入密钥，然后重启 <code>npm run dev</code>。
        </div>
      ) : null}

      {error ? (
        <div className="banner" style={{ borderColor: "rgba(234,67,53,0.5)", background: "rgba(234,67,53,0.12)" }}>
          {error}
        </div>
      ) : null}

      <div className="bar">
        <div className="bar-left">
          <div className="bar-left-inner">
            <span className="bar-time">{formatClock(clock)}</span>
            <span className="bar-code">{meetingCode}</span>
          </div>
        </div>

        <div className="bar-center">
          <button
            type="button"
            className={`ctrl ${listening ? "" : "muted"}`}
            onClick={toggleMic}
            disabled={!started}
            title={
              listening
                ? "关闭麦克风（关闭后无法语音识别）"
                : "开启麦克风：语音识别 + 打断 AI（未开启则听不到你说话）"
            }
            aria-pressed={listening}
          >
            <IconMic muted={!listening} />
            <span className="sr-only">麦克风</span>
          </button>
          <button
            type="button"
            className={`ctrl ${camOn ? "" : "muted"}`}
            onClick={() => setCamOn((c) => !c)}
            title={camOn ? "关闭摄像头" : "开启摄像头"}
            aria-pressed={camOn}
          >
            <IconCam off={!camOn} />
            <span className="sr-only">摄像头</span>
          </button>
          <button type="button" className="ctrl danger" onClick={onLeave} title="离开会议">
            <IconPhoneDown />
            <span className="sr-only">离开</span>
          </button>
        </div>

        <div className="bar-right">
          <button type="button" className="icon-btn" onClick={() => setTraceOpen(true)} title="Trace（快捷键 `）">
            <span className="trace-icon">⌗</span>
          </button>
          <button type="button" className="icon-btn" title="参与者（2）">
            <IconPeople />
          </button>
          <button type="button" className="icon-btn" title="聊天">
            <IconChat />
          </button>
        </div>
      </div>

      <TraceDrawer
        open={traceOpen}
        onClose={() => setTraceOpen(false)}
        traceId={traceId}
        firstTokenMs={firstTokenMs}
        events={traceLog}
      />

      {!started ? (
        <div className="start-overlay">
          <div className="start-card">
            <h1>AI 实时面试官</h1>
            <p>
              <strong>混合架构</strong>：小模型流式「快答」立即朗读（按标点分句 + 预缓冲）；大模型在后台「慢想」生成小结与深追建议。
              浏览器端 <strong>VAD 能量检测</strong>：你在 AI 说话或思考时开口，会<strong>打断</strong>并重置本轮。
              按键盘 <code>`</code> 打开 <strong>Trace</strong> 查看首 token 等事件（演示用）。
            </p>
            <p className="start-browser-hint">
              <strong>语音识别</strong>：请用<strong>本机安装的 Chrome 或 Edge</strong>打开 <code>http://localhost:5173</code>。Cursor / IDE
              内置浏览器常无法完整使用 Web Speech 或连不上 Google，与你在哪个国家无关。
            </p>
            <div className="start-actions">
              <button type="button" className="btn-main" onClick={onStart} disabled={apiReady === false || busy}>
                {busy ? "正在连接…" : "开始面试"}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setStarted(true)} disabled={busy}>
                仅进入房间（稍后手动开始）
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
