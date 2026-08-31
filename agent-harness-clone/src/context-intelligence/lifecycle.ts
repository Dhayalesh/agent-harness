import type {
  ContextLifecycleEvent,
  ContextLifecycleState,
} from './contracts.js';
import { deepClone, id, now } from './utils.js';

const ORDER: readonly ContextLifecycleState[] = [
  'discovered',
  'retrieved',
  'observed',
  'evaluated',
  'admitted',
  'ranked',
  'compressed',
  'offloaded',
  'recalled',
  'used',
  'archived',
];

/** Bounded, content-free state-transition journal for context items and needs. */
export class ContextLifecycleManager {
  private readonly events: ContextLifecycleEvent[];

  constructor(
    initial: readonly ContextLifecycleEvent[] = [],
    private readonly maximumEvents = 500,
  ) {
    this.events = initial.slice(-maximumEvents).map((event) => deepClone(event));
  }

  transition(input: {
    requestId: string;
    itemId?: string;
    needId?: string;
    from?: ContextLifecycleState;
    to: ContextLifecycleState;
    reason: string;
    component: string;
    metadata?: Readonly<Record<string, unknown>>;
  }): ContextLifecycleEvent {
    const monotonic =
      input.from === undefined ||
      input.to === 'recalled' ||
      ORDER.indexOf(input.to) >= ORDER.indexOf(input.from);
    const event: ContextLifecycleEvent = {
      id: id('context_lifecycle'),
      requestId: input.requestId,
      ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      ...(input.needId === undefined ? {} : { needId: input.needId }),
      ...(input.from === undefined ? {} : { from: input.from }),
      to: input.to,
      reason: input.reason,
      component: input.component,
      metadata: {
        ...(input.metadata ?? {}),
        transitionValid: monotonic,
      },
      at: now(),
    };
    this.events.push(event);
    if (this.events.length > this.maximumEvents) {
      this.events.splice(0, this.events.length - this.maximumEvents);
    }
    return deepClone(event);
  }

  forRequest(requestId: string): readonly ContextLifecycleEvent[] {
    return this.events
      .filter((event) => event.requestId === requestId)
      .map((event) => deepClone(event));
  }

  snapshot(): readonly ContextLifecycleEvent[] {
    return this.events.map((event) => deepClone(event));
  }
}
