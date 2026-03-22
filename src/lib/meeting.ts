export function randomMeetingCode(): string {
  const part = () =>
    Math.random()
      .toString(36)
      .slice(2, 5)
      .padEnd(3, "x");
  return `${part()}-${part()}-${part()}`;
}

export function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
