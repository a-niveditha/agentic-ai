/** Per-run cap on tool executions, shared by every tool built for one agent run. */
export class ToolBudget {
  private count = 0;
  constructor(readonly limit: number) {}

  get used(): number {
    return this.count;
  }

  /** Returns true if the call may proceed (and counts it). */
  tryConsume(): boolean {
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }
}

export const BUDGET_EXHAUSTED_MESSAGE =
  'ERROR: The tool-call budget for this request is used up. Do not call more tools; answer with the information you already have and say what you could not look up.';
