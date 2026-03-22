import { useCallback, useEffect, useRef, useState } from "react";
import { readSseChat, type TraceEvt } from "../lib/sseChat";
import { usePhrasePlayback } from "./usePhrasePlayback";

export type ChatMsg = { role: "user" | "assistant"; content: string };

export type SessionState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "recovering";

type RecognitionCtor = new () => SpeechRecognition;

function pickRecognition(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useHybridInterview(opts: { speechActive: boolean; sessionActive: boolean }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAi, setLiveAi] = useState("");
  const [listening, setListening] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [slowInsight, setSlowInsight] = useState<string | null>(null);
  const [traceLog, setTraceLog] = useState<TraceEvt[]>([]);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null);
  const [useOpenAiTts, setUseOpenAiTts] = useState(false);
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const snapshotRef = useRef<ChatMsg[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const recRef = useRef<SpeechRecognition | null>(null);
  const shouldListenRef = useRef(false);
  const prevSpeechRef = useRef(false);
  const recoveringTimerRef = useRef<number | null>(null);

  const onSpeakingChange = useCallback((v: boolean) => {
    setSessionState((s) => {
      if (v) return "speaking";
      if (s === "speaking") return shouldListenRef.current ? "listening" : "idle";
      return s;
    });
  }, []);

  const playback = usePhrasePlayback({
    useOpenAiTts,
    traceId,
    preRollMs: 55,
    onSpeakingChange,
  });

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j: { hasKey?: boolean; ttsEnabled?: boolean }) => {
        setApiReady(Boolean(j.hasKey));
        setUseOpenAiTts(Boolean(j.ttsEnabled));
      })
      .catch(() => setApiReady(false));
  }, []);

  const appendTrace = useCallback((e: TraceEvt) => {
    setTraceLog((l) => [...l.slice(-120), e]);
  }, []);

  const enterRecovering = useCallback((msg: string) => {
    setError(msg);
    setSessionState("recovering");
    if (recoveringTimerRef.current) clearTimeout(recoveringTimerRef.current);
    recoveringTimerRef.current = window.setTimeout(() => {
      setSessionState(shouldListenRef.current ? "listening" : "idle");
      recoveringTimerRef.current = null;
    }, 2200);
  }, []);

  const stopListening = useCallback(() => {
    shouldListenRef.current = false;
    const r = recRef.current;
    recRef.current = null;
    try {
      r?.stop();
    } catch {
      /* ignore */
    }
    setListening(false);
    setLiveUser("");
    setSessionState("idle");
  }, []);

  const bargeIn = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    playback.stopAll();
    busyRef.current = false;
    setLiveAi("");
    setMessages(snapshotRef.current);
    messagesRef.current = snapshotRef.current;
    setFirstTokenMs(null);
    if (shouldListenRef.current) setSessionState("listening");
  }, [playback]);

  useEffect(() => {
    const up = opts.speechActive && !prevSpeechRef.current;
    prevSpeechRef.current = opts.speechActive;
    if (!up || !opts.sessionActive) return;
    if (sessionState === "speaking" || sessionState === "thinking") bargeIn();
  }, [opts.speechActive, opts.sessionActive, sessionState, bargeIn]);

  const runRefine = useCallback(
    async (tid: string | null, tail: ChatMsg[], fast: string) => {
      try {
        const res = await fetch("/api/refine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: tail, fastReply: fast, traceId: tid }),
        });
        const j = (await res.json()) as {
          refine?: { summary?: string; follow_up?: string; rubric?: string[] };
          ms?: number;
        };
        if (!res.ok) return;
        const r = j.refine;
        if (!r) return;
        const bits: string[] = [];
        if (r.summary) bits.push(`小结：${r.summary}`);
        if (r.follow_up) bits.push(`深追：${r.follow_up}`);
        if (r.rubric?.length) bits.push(`信号：${r.rubric.join(" · ")}`);
        setSlowInsight(bits.join("\n"));
        if (typeof j.ms === "number") appendTrace({ e: "refine_client_done", ms: j.ms });
      } catch {
        /* ignore background lane */
      }
    },
    [appendTrace]
  );

  const streamTurn = useCallback(
    async (messagesForApi: ChatMsg[], tid: string) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setFirstTokenMs(null);
      setLiveAi("");
      playback.resetGeneration();
      busyRef.current = true;
      setSessionState("thinking");
      setError(null);
      setSlowInsight(null);

      let acc = "";
      const tReq = performance.now();
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({ messages: messagesForApi, traceId: tid }),
        });
        await readSseChat(res, {
          signal: ac.signal,
          onTrace: (evt) => {
            appendTrace(evt);
            if (evt.e === "llm_fast_first_token" && typeof evt.ms === "number") {
              setFirstTokenMs(Math.round(evt.ms));
            }
          },
          onTraceId: (id) => setTraceId(id),
          onToken: (t) => {
            acc += t;
            setLiveAi(acc);
            playback.pushDelta(t);
            playback.schedulePreRollFlush();
          },
        });
        playback.flush();
        const finalText = acc.trim();
        const base = messagesRef.current;
        const withAssistant: ChatMsg[] = [...base, { role: "assistant", content: finalText }];
        setMessages(withAssistant);
        messagesRef.current = withAssistant;
        snapshotRef.current = withAssistant;
        setLiveAi("");
        void runRefine(tid, withAssistant, finalText);
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setMessages(snapshotRef.current);
          messagesRef.current = snapshotRef.current;
        } else {
          setMessages(snapshotRef.current);
          messagesRef.current = snapshotRef.current;
          enterRecovering(e instanceof Error ? e.message : "请求失败");
        }
      } finally {
        busyRef.current = false;
        abortRef.current = null;
        const dt = Math.round(performance.now() - tReq);
        appendTrace({ e: "turn_wall_ms", ms: dt });
      }
    },
    [appendTrace, enterRecovering, playback, runRefine]
  );

  const sendUserText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      snapshotRef.current = [...messagesRef.current];
      const tid = crypto.randomUUID();
      setTraceId(tid);
      const next: ChatMsg[] = [...messagesRef.current, { role: "user", content: trimmed }];
      setMessages(next);
      messagesRef.current = next;
      await streamTurn(next, tid);
    },
    [streamTurn]
  );

  const startListening = useCallback(() => {
    if (listening) return;
    const Ctor = pickRecognition();
    if (!Ctor) {
      setError("当前浏览器不支持语音识别（请用桌面 Chrome / Edge 打开，内置浏览器常不支持）。");
      return;
    }

    const prev = recRef.current;
    if (prev) {
      shouldListenRef.current = false;
      recRef.current = null;
      try {
        prev.stop();
      } catch {
        /* ignore */
      }
    }

    shouldListenRef.current = true;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "zh-CN";

    rec.onresult = (ev: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) final += t;
        else interim += t;
      }
      setLiveUser(final || interim);
      if (final.trim() && !busyRef.current) void sendUserText(final);
    };

    rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
      const code = ev.error || "unknown";
      /* stop() / 切换实例 / StrictMode 等会报 aborted，不弹红条 */
      if (code === "aborted" || code === "canceled") {
        if (recRef.current === rec) {
          recRef.current = null;
          shouldListenRef.current = false;
        }
        setListening(false);
        return;
      }
      if (!shouldListenRef.current) return;
      if (recRef.current === rec) recRef.current = null;
      shouldListenRef.current = false;
      setListening(false);
      setSessionState("idle");
      const hint =
        code === "not-allowed"
          ? "浏览器未获得麦克风权限，请在地址栏旁开启权限后再点麦克风。"
          : code === "no-speech"
            ? "未检测到语音，请靠近麦克风或检查输入设备。"
            : code === "network"
              ? "无法连接 Google 语音识别（与地区无关：IDE 内置浏览器、广告拦截、校园/公司网、DNS 等都会导致）。请用系统里的 Chrome/Edge 直接打开 localhost:5173 再试麦克风，或直接用下方「文字回答」。"
              : `语音识别出错（${code}），请再点一次麦克风，或改用文字回答。`;
      setError(hint);
    };

    rec.onend = () => {
      if (!shouldListenRef.current) {
        setListening(false);
        return;
      }
      if (recRef.current !== rec) return;
      window.setTimeout(() => {
        if (!shouldListenRef.current || recRef.current !== rec) return;
        try {
          rec.start();
        } catch {
          recRef.current = null;
          shouldListenRef.current = false;
          setListening(false);
          setSessionState("idle");
          setError("语音识别已停止，请再点麦克风继续。");
        }
      }, 0);
    };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
      setSessionState("listening");
      setError(null);
    } catch {
      shouldListenRef.current = false;
      recRef.current = null;
      setError("无法启动麦克风识别，请检查权限。");
    }
  }, [listening, sendUserText]);

  const toggleMic = useCallback(() => {
    if (listening) stopListening();
    else {
      playback.stopAll();
      startListening();
    }
  }, [listening, playback, startListening, stopListening]);

  const beginInterview = useCallback(async () => {
    if (busyRef.current) return;
    snapshotRef.current = [];
    const tid = crypto.randomUUID();
    setTraceId(tid);
    setTraceLog([]);
    setMessages([]);
    messagesRef.current = [];
    setSlowInsight(null);
    busyRef.current = true;
    setSessionState("connecting");
    setError(null);
    playback.resetGeneration();
    playback.stopAll();

    const seed: ChatMsg[] = [
      {
        role: "user",
        content:
          "候选人已进入会议室。请用中文简短打招呼（一两句话），然后提出第一个面试问题。不要输出角色扮演说明。",
      },
    ];
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setFirstTokenMs(null);
    setLiveAi("");
    let acc = "";
    const tReq = performance.now();
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({ messages: seed, traceId: tid }),
      });
      await readSseChat(res, {
        signal: ac.signal,
        onTrace: (evt) => {
          appendTrace(evt);
          if (evt.e === "llm_fast_first_token" && typeof evt.ms === "number") setFirstTokenMs(Math.round(evt.ms));
        },
        onTraceId: (id) => setTraceId(id),
        onToken: (t) => {
          acc += t;
          setLiveAi(acc);
          playback.pushDelta(t);
          playback.schedulePreRollFlush();
        },
      });
      playback.flush();
      const finalText = acc.trim();
      const withAssistant: ChatMsg[] = [{ role: "assistant", content: finalText }];
      setMessages(withAssistant);
      messagesRef.current = withAssistant;
      snapshotRef.current = withAssistant;
      setLiveAi("");
      setSessionState(shouldListenRef.current ? "listening" : "idle");
      void runRefine(tid, withAssistant, finalText);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        enterRecovering(e instanceof Error ? e.message : "无法开始面试");
      }
    } finally {
      busyRef.current = false;
      abortRef.current = null;
      appendTrace({ e: "open_wall_ms", ms: Math.round(performance.now() - tReq) });
    }
  }, [appendTrace, enterRecovering, playback, runRefine]);

  useEffect(() => () => stopListening(), [stopListening]);

  const aiSpeaking = sessionState === "speaking";
  const busy = sessionState === "thinking" || sessionState === "connecting";

  return {
    messages,
    liveUser,
    liveAi,
    listening,
    aiSpeaking,
    sessionState,
    busy,
    error,
    apiReady,
    slowInsight,
    traceLog,
    traceId,
    firstTokenMs,
    useOpenAiTts,
    beginInterview,
    toggleMic,
    stopListening,
    startListening,
    sendUserText,
  };
}
