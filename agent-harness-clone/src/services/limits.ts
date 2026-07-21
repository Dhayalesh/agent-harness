import type { ModelUsage } from '../models/provider.js';

export type BudgetLimits = {
  maxTotalTokens?: number;
  maxCostUsd?: number;
};

export class BudgetTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;

  constructor(private readonly limits: BudgetLimits = {}) {}

  add(usage: ModelUsage): { exceeded: boolean; reason?: string } {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.costUsd += usage.estimatedCostUsd ?? 0;
    const total = this.inputTokens + this.outputTokens;
    if (this.limits.maxTotalTokens !== undefined && total > this.limits.maxTotalTokens) {
      return { exceeded: true, reason: `Token budget exceeded (${total})` };
    }
    if (this.limits.maxCostUsd !== undefined && this.costUsd > this.limits.maxCostUsd) {
      return { exceeded: true, reason: `Cost budget exceeded (${this.costUsd})` };
    }
    return { exceeded: false };
  }

  snapshot(): { inputTokens: number; outputTokens: number; costUsd: number } {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
    };
  }
}

export type RateLimitOptions = {
  maximumRuns: number;
  windowMs: number;
  clock?: () => number;
};

export class SessionRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly clock: () => number;

  constructor(private readonly options: RateLimitOptions) {
    this.clock = options.clock ?? Date.now;
  }

  acquire(): boolean {
    const now = this.clock();
    while (this.timestamps[0] !== undefined && this.timestamps[0] <= now - this.options.windowMs) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.options.maximumRuns) return false;
    this.timestamps.push(now);
    return true;
  }
}
