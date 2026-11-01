/**
 * Free, in-memory limits for the public question endpoint. Each server instance counts separately and counts reset
 * on restart, so this slows casual abuse rather than stopping a determined attacker. The provider's own quota is
 * the hard ceiling.
 */

export class WindowCounter {
  private hits = new Map<string, number[]>();

  constructor(private limit: number, private windowMs: number, private maxKeys = 5000) {}

  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
    return true;
  }
}

const perClient = new WindowCounter(12, 60e3);
const llmDaily = new WindowCounter(Number(process.env.LLM_DAILY_LIMIT) || 300, 24 * 3600e3);

export function clientKey(headers: Headers): string {
  return headers.get("x-real-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export const allowQuestion = (key: string) => perClient.allow(key);

/** When spent, questions still work and fall back to direct quotes, so abuse can't take the feature down. */
export const allowLlmCall = () => llmDaily.allow("all");

/** Browsers send Origin on POST. This stops other sites spending the quota; scripts can still forge it. */
export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (headers.get("x-forwarded-host") ?? headers.get("host"));
  } catch {
    return false;
  }
}
