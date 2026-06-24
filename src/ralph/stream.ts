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

type StreamEvent = {
  type: string;
  message?: {
    content?: {
      type: string;
      text?: string;
      name?: string;
    }[];
  };
  total_cost_usd?: number;
  result?: string;
  usage?: Usage;
};

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
  tokens = 0;

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

    if (evt.type === "assistant" && evt.message?.content) {
      for (const block of evt.message.content) {
        // Surface only the agent's own prose; tool calls are too noisy to log.
        if (block.type === "text" && block.text) {
          this.write(block.text);
          if (block.text.includes(COMPLETION_SIGNAL)) this.completed = true;
        }
      }
    }

    if (evt.type === "result") {
      if (typeof evt.total_cost_usd === "number") this.cost = evt.total_cost_usd;
      if (evt.usage) {
        this.tokens =
          (evt.usage.input_tokens ?? 0) +
          (evt.usage.output_tokens ?? 0) +
          (evt.usage.cache_creation_input_tokens ?? 0) +
          (evt.usage.cache_read_input_tokens ?? 0);
      }
      if (
        typeof evt.result === "string" &&
        evt.result.includes(COMPLETION_SIGNAL)
      ) {
        this.completed = true;
      }
    }
  }
}
