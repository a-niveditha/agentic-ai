import { z } from 'zod';
import { BaseAgentTool, type AgentContext, type ToolOutput } from '../../agent/src/index.js';

const schema = z.object({});

/** A tool that blocks until its signal aborts (or a timeout), to test cancellation propagation. */
export class SlowTool extends BaseAgentTool<typeof schema> {
  readonly name = 'slow_tool';
  readonly description = 'Takes a long time.';
  readonly schema = schema;
  started!: Promise<void>;
  private markStarted!: () => void;
  sawAbort = false;
  runs = 0;

  constructor(private readonly maxMs = 15_000) {
    super();
    this.reset();
  }

  reset() {
    this.started = new Promise<void>((r) => (this.markStarted = r));
    this.sawAbort = false;
  }

  protected async run(_input: unknown, _ctx: AgentContext, signal?: AbortSignal): Promise<ToolOutput> {
    this.runs++;
    this.markStarted();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.maxMs);
      signal?.addEventListener('abort', () => { this.sawAbort = true; clearTimeout(t); resolve(); }, { once: true });
    });
    return { data: 'finished' };
  }
}
