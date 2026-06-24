// ---------------------------------------------------------------------------
// Parser for `claude -p --output-format stream-json` output. Lines in, a live
// digest written out, and `{ completed, cost }` observable at the end. Pure
// enough to drive from a test by feeding it lines — no process spawning here.
// ---------------------------------------------------------------------------

/** The literal token the agent emits when no open sub-issue remains. */
export const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

/**
 * Rate-limit snapshot the CLI emits via `rate_limit_event`. The headless stream
 * carries no numeric usage percentage — only this status enum — so "near the
 * limit" is read off `status`, not a computed ratio.
 *   allowed → allowed_warning (approaching the cap) → rejected (over it)
 */
export type RateLimitInfo = {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
};

type StreamEvent = {
  type: string;
  message?: {
    content?: {
      type: string;
      text?: string;
      name?: string;
    }[];
    usage?: Usage;
  };
  total_cost_usd?: number;
  result?: string;
  usage?: Usage;
  rate_limit_info?: RateLimitInfo;
};

/** Input-side tokens the model reads in one turn — its context window load. */
function contextWindow(usage: Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

/** Compact a token count, e.g. 1500 → "1.5k", 100000 → "100k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  if (k < 10) return `${k.toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(k)}k`;
}

/**
 * Accumulates the state of one streamed iteration. Feed it raw lines; it writes
 * a human digest via the injected writer and tracks whether the completion
 * signal appeared and the final reported cost.
 */
export class IterationDigest {
  completed = false;
  cost = 0;
  /**
   * Peak context-window load (largest single turn's input side). This is the
   * meaningful "how full did the window get" number — unlike summing the final
   * cumulative usage, where cache reads are re-counted every turn and balloon
   * a 100k-context iteration into millions of "tokens".
   */
  contextTokens = 0;
  /** Tokens the agent generated across the iteration. */
  outputTokens = 0;
  /** Latest five-hour rate-limit snapshot seen in the stream, if any. */
  rateLimit?: RateLimitInfo;

  constructor(private readonly write: (chunk: string) => void) {}

  processLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let evt: StreamEvent;
    try {
      evt = JSON.parse(trimmed) as StreamEvent;
    } catch {
      return;
    }

    if (evt.type === "rate_limit_event" && evt.rate_limit_info) {
      // Keep only the five-hour window; the CLI also emits weekly events.
      if (evt.rate_limit_info.rateLimitType === "five_hour") {
        this.rateLimit = evt.rate_limit_info;
      }
    }

    if (evt.type === "assistant" && evt.message) {
      if (evt.message.usage) {
        this.contextTokens = Math.max(
          this.contextTokens,
          contextWindow(evt.message.usage),
        );
        this.outputTokens += evt.message.usage.output_tokens ?? 0;
      }
      for (const block of evt.message.content ?? []) {
        // Surface only the agent's own prose; tool calls are too noisy to log.
        if (block.type === "text" && block.text) {
          this.write(block.text);
          if (block.text.includes(COMPLETION_SIGNAL)) this.completed = true;
          this.write("\n");
        }
      }
    }

    if (evt.type === "result") {
      if (typeof evt.total_cost_usd === "number")
        this.cost = evt.total_cost_usd;
      if (
        typeof evt.result === "string" &&
        evt.result.includes(COMPLETION_SIGNAL)
      ) {
        this.completed = true;
      }
    }
  }
}
