/** Extract completed phrases from a growing assistant stream (Chinese + Latin punctuation). */
const DELIM = /([。！？；…]|[.!?]+\s|\n+)/;

export function drainPhrases(buffer: string): { phrases: string[]; rest: string } {
  const phrases: string[] = [];
  let rest = buffer;
  let guard = 0;
  while (guard++ < 200) {
    const m = rest.match(DELIM);
    if (!m || m.index === undefined) break;
    const end = m.index + m[0].length;
    const chunk = rest.slice(0, end).trim();
    rest = rest.slice(end).trimStart();
    if (chunk.length > 0) phrases.push(chunk);
  }
  return { phrases, rest };
}

export function flushRest(rest: string): string[] {
  const t = rest.trim();
  return t ? [t] : [];
}
