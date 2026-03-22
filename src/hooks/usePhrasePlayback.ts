import { useCallback, useRef } from "react";
import { drainPhrases, flushRest } from "../lib/phraseSplit";

function guessLang(text: string): string {
  return /[\u4e00-\u9fff]/.test(text) ? "zh-CN" : "en-US";
}

/**
 * Phrase-chunked playback: starts first clause quickly; optional OpenAI MP3 via queue + Web Audio.
 */
export function usePhrasePlayback(opts: {
  useOpenAiTts: boolean;
  traceId: string | null;
  preRollMs: number;
  onSpeakingChange?: (v: boolean) => void;
}) {
  const bufferRef = useRef("");
  const queueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  const cancelledRef = useRef(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const endTimeRef = useRef(0);
  const preRollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, []);

  const stopAll = useCallback(() => {
    cancelledRef.current = true;
    window.speechSynthesis.cancel();
    for (const s of activeSourcesRef.current) {
      try {
        s.stop(0);
      } catch {
        /* already ended */
      }
    }
    activeSourcesRef.current = [];
    if (preRollTimerRef.current) {
      clearTimeout(preRollTimerRef.current);
      preRollTimerRef.current = null;
    }
    bufferRef.current = "";
    queueRef.current = [];
    playingRef.current = false;
    endTimeRef.current = 0;
    opts.onSpeakingChange?.(false);
  }, [opts]);

  const resetGeneration = useCallback(() => {
    cancelledRef.current = false;
    bufferRef.current = "";
    queueRef.current = [];
    if (preRollTimerRef.current) {
      clearTimeout(preRollTimerRef.current);
      preRollTimerRef.current = null;
    }
  }, []);

  const playSynthPhrase = useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = guessLang(text);
        u.rate = 1.06;
        u.onstart = () => opts.onSpeakingChange?.(true);
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.speak(u);
      }),
    [opts]
  );

  const playMp3Phrase = useCallback(
    async (text: string) => {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, traceId: opts.traceId }),
      });
      if (!res.ok) {
        await playSynthPhrase(text);
        return;
      }
      if (cancelledRef.current) return;
      const ab = await res.arrayBuffer();
      if (cancelledRef.current) return;
      const ctx = ensureCtx();
      if (ctx.state === "suspended") await ctx.resume();
      const buf = await ctx.decodeAudioData(ab.slice(0));
      const now = ctx.currentTime;
      const startAt = Math.max(now, endTimeRef.current);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      activeSourcesRef.current.push(src);
      opts.onSpeakingChange?.(true);
      src.start(startAt);
      endTimeRef.current = startAt + buf.duration;
      await new Promise<void>((r) => {
        src.onended = () => {
          activeSourcesRef.current = activeSourcesRef.current.filter((x) => x !== src);
          r();
        };
      });
    },
    [ensureCtx, opts, playSynthPhrase]
  );

  const pump = useCallback(async () => {
    if (playingRef.current || cancelledRef.current) return;
    if (queueRef.current.length === 0) {
      opts.onSpeakingChange?.(false);
      return;
    }
    playingRef.current = true;
    while (queueRef.current.length > 0 && !cancelledRef.current) {
      const phrase = queueRef.current.shift()!;
      if (opts.useOpenAiTts) await playMp3Phrase(phrase);
      else await playSynthPhrase(phrase);
    }
    playingRef.current = false;
    if (!cancelledRef.current && queueRef.current.length === 0) opts.onSpeakingChange?.(false);
  }, [opts, playMp3Phrase, playSynthPhrase]);

  const pushDelta = useCallback(
    (delta: string) => {
      if (cancelledRef.current) return;
      bufferRef.current += delta;
      const { phrases, rest } = drainPhrases(bufferRef.current);
      bufferRef.current = rest;
      if (phrases.length === 0) return;
      queueRef.current.push(...phrases);
      void pump();
    },
    [pump]
  );

  const flush = useCallback(() => {
    const tail = flushRest(bufferRef.current);
    bufferRef.current = "";
    queueRef.current.push(...tail);
    void pump();
  }, [pump]);

  /** First clause: optional micro pre-roll so ultra-short openings don't stutter. */
  const schedulePreRollFlush = useCallback(() => {
    if (preRollTimerRef.current) clearTimeout(preRollTimerRef.current);
    preRollTimerRef.current = setTimeout(() => {
      preRollTimerRef.current = null;
      if (bufferRef.current.trim().length > 0 && queueRef.current.length === 0 && !playingRef.current) {
        flush();
      }
    }, opts.preRollMs);
  }, [flush, opts.preRollMs]);

  return {
    pushDelta,
    flush,
    stopAll,
    resetGeneration,
    schedulePreRollFlush,
  };
}
