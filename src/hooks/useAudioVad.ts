import { useCallback, useEffect, useRef, useState } from "react";

const RMS_ON = 0.045;
const RMS_OFF = 0.028;
const MS_SPEECH_START = 90;
const MS_SPEECH_END = 220;

/**
 * Lightweight energy VAD on a MediaStream (for barge-in / ducking signals).
 * Not a substitute for ASR; pairs with SpeechRecognition.
 */
export function useAudioVad(stream: MediaStream | null) {
  const [speechActive, setSpeechActive] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const animRef = useRef<number>(0);
  const aboveSinceRef = useRef<number | null>(null);
  const belowSinceRef = useRef<number | null>(null);
  const activeRef = useRef(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    animRef.current = 0;
    if (ctxRef.current) {
      void ctxRef.current.close();
      ctxRef.current = null;
    }
    activeRef.current = false;
    setSpeechActive(false);
    aboveSinceRef.current = null;
    belowSinceRef.current = null;
  }, []);

  const start = useCallback(
    (s: MediaStream) => {
      stop();
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(s);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();

        if (rms >= RMS_ON) {
          belowSinceRef.current = null;
          if (aboveSinceRef.current == null) aboveSinceRef.current = now;
          else if (!activeRef.current && now - aboveSinceRef.current >= MS_SPEECH_START) {
            activeRef.current = true;
            setSpeechActive(true);
          }
        } else if (rms <= RMS_OFF) {
          aboveSinceRef.current = null;
          if (activeRef.current) {
            if (belowSinceRef.current == null) belowSinceRef.current = now;
            else if (now - belowSinceRef.current >= MS_SPEECH_END) {
              activeRef.current = false;
              setSpeechActive(false);
              belowSinceRef.current = null;
            }
          }
        }

        animRef.current = requestAnimationFrame(tick);
      };
      animRef.current = requestAnimationFrame(tick);
    },
    [stop]
  );

  useEffect(() => {
    if (!stream) {
      stop();
      return;
    }
    start(stream);
    return stop;
  }, [stream, start, stop]);

  return { speechActive };
}
