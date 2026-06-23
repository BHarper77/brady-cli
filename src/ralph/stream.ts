// ---------------------------------------------------------------------------
// Parser for `claude -p --output-format stream-json` output. Lines in, a live
// digest written out, and `{ completed, cost }` observable at the end. Pure
// enough to drive from a test by feeding it lines — no process spawning here.
// ---------------------------------------------------------------------------

/** The literal token the agent emits when no open sub-issue remains. */
export const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

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
};

/**
 * Accumulates the state of one streamed iteration. Feed it raw lines; it writes
 * a human digest via the injected writer and tracks whether the completion
 * signal appeared and the final reported cost.
 */
export class IterationDigest {
  completed = false;
  cost = 0;

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
        if (block.type === "text" && block.text) {
          this.write(block.text);
          if (block.text.includes(COMPLETION_SIGNAL)) this.completed = true;
        } else if (block.type === "tool_use") {
          this.write(`\n  → ${block.name ?? "tool"}\n`);
        }
      }
    }

    if (evt.type === "result") {
      if (typeof evt.total_cost_usd === "number") this.cost = evt.total_cost_usd;
      if (
        typeof evt.result === "string" &&
        evt.result.includes(COMPLETION_SIGNAL)
      ) {
        this.completed = true;
      }
    }
  }
}
