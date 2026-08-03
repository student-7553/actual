import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InteractionPayload } from './types';

type MockPerformanceEventTimingEntry = PerformanceEntry & {
  interactionId?: number;
  processingStart: number;
  processingEnd: number;
  target?: Node;
  targetSelector?: string;
};

const observerCallbacks: Record<
  string,
  (entries: PerformanceEntry[]) => void
> = {};

class MockPerformanceObserver {
  static supportedEntryTypes = [
    'event',
    'first-input',
    'long-animation-frame',
  ];

  constructor(
    private callback: (list: { getEntries: () => PerformanceEntry[] }) => void,
  ) {}

  observe(options: { type: string }) {
    observerCallbacks[options.type] = entries => {
      this.callback({ getEntries: () => entries });
    };
  }
}

function createEventEntry(
  overrides: Partial<MockPerformanceEventTimingEntry> = {},
): MockPerformanceEventTimingEntry {
  return {
    name: 'click',
    entryType: 'event',
    startTime: 100,
    duration: 48,
    processingStart: 108,
    processingEnd: 140,
    interactionId: 1,
    toJSON: () => ({}),
    ...overrides,
  };
}

describe('interactionTracker', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.keys(observerCallbacks).forEach(key => {
      delete observerCallbacks[key];
    });

    class PerformanceEventTiming {}

    Object.defineProperty(PerformanceEventTiming.prototype, 'interactionId', {
      value: 0,
      configurable: true,
    });

    vi.stubGlobal('PerformanceEventTiming', PerformanceEventTiming);
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    vi.stubGlobal(
      'requestIdleCallback',
      (callback: IdleRequestCallback) => {
        const id = window.setTimeout(() => {
          callback({ didTimeout: false, timeRemaining: () => 50 });
        }, 0);
        return id;
      },
    );
    vi.stubGlobal('cancelIdleCallback', (id: number) => {
      window.clearTimeout(id);
    });
  });

  afterEach(async () => {
    const tracker = await import('./interactionTracker');
    tracker.resetInteractionTracker();
    vi.unstubAllGlobals();
  });

  async function loadTracker() {
    return import('./interactionTracker');
  }

  async function flushFinalize() {
    await new Promise<void>(resolve => {
      window.setTimeout(resolve, 0);
    });
  }

  it('starts observers only after startInteractionTracking is called', async () => {
    const tracker = await loadTracker();

    expect(Object.keys(observerCallbacks)).toEqual([]);
    expect(tracker.startInteractionTracking()).toBe(true);
    expect(Object.keys(observerCallbacks).sort()).toEqual([
      'event',
      'first-input',
      'long-animation-frame',
    ]);
    expect(tracker.startInteractionTracking()).toBe(true);
  });

  it('captures finalized interactions through the registered listener', async () => {
    const tracker = await loadTracker();
    const onInteraction = vi.fn<(payload: InteractionPayload) => void>();

    tracker.registerInteractionListener(onInteraction);
    tracker.startInteractionTracking();

    observerCallbacks.event?.([createEventEntry()]);

    await flushFinalize();

    expect(onInteraction).toHaveBeenCalledTimes(1);
    expect(onInteraction.mock.calls[0][0]).toMatchObject({
      name: 'INTERACTION',
      interactionId: 1,
      value: 48,
      attribution: {
        interactionType: 'pointer',
        inputDelay: 8,
        processingDuration: 32,
        presentationDelay: 8,
      },
    });
  });

  it('groups multiple entries for the same interaction id', async () => {
    const tracker = await loadTracker();
    const onInteraction = vi.fn<(payload: InteractionPayload) => void>();

    tracker.registerInteractionListener(onInteraction);
    tracker.startInteractionTracking();

    observerCallbacks.event?.([
      createEventEntry({
        name: 'keydown',
        startTime: 100,
        duration: 40,
        processingStart: 104,
        processingEnd: 120,
      }),
      createEventEntry({
        name: 'keyup',
        startTime: 120,
        duration: 60,
        processingStart: 124,
        processingEnd: 160,
      }),
    ]);

    await flushFinalize();

    expect(onInteraction).toHaveBeenCalledTimes(1);
    expect(onInteraction.mock.calls[0][0]).toMatchObject({
      interactionId: 1,
      value: 60,
      attribution: {
        interactionType: 'keyboard',
        interactionTime: 100,
        inputDelay: 4,
        processingDuration: 56,
        presentationDelay: 20,
      },
    });
    expect(onInteraction.mock.calls[0][0]).not.toHaveProperty('entries');
    expect(onInteraction.mock.calls[0][0].attribution).not.toHaveProperty(
      'processedEventEntries',
    );
  });

  it('records typed input on keyboard interactions by matching key event timestamps', async () => {
    const tracker = await loadTracker();
    const onInteraction = vi.fn<(payload: InteractionPayload) => void>();

    tracker.registerInteractionListener(onInteraction);
    tracker.startInteractionTracking();

    const keydown = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      bubbles: true,
      cancelable: true,
    });
    const keyup = new KeyboardEvent('keyup', {
      key: 'a',
      code: 'KeyA',
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(keydown);
    document.dispatchEvent(keyup);

    observerCallbacks.event?.([
      createEventEntry({
        name: 'keydown',
        startTime: keydown.timeStamp,
        duration: 40,
        processingStart: keydown.timeStamp + 4,
        processingEnd: keydown.timeStamp + 20,
      }),
      createEventEntry({
        name: 'keyup',
        startTime: keyup.timeStamp,
        duration: 60,
        processingStart: keyup.timeStamp + 4,
        processingEnd: keyup.timeStamp + 40,
      }),
    ]);

    await flushFinalize();

    expect(onInteraction).toHaveBeenCalledTimes(1);

    const payload = onInteraction.mock.calls[0][0];
    expect(payload.attribution).toMatchObject({
      interactionType: 'keyboard',
      typedInput: 'a',
      typedKey: {
        key: 'a',
        code: 'KeyA',
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        repeat: false,
      },
    });
    expect(payload).not.toHaveProperty('entries');
    expect(payload.attribution).not.toHaveProperty('processedEventEntries');
  });

  it('keeps typed input when a keyboard interaction is reported again', async () => {
    const tracker = await loadTracker();
    const onInteraction = vi.fn<(payload: InteractionPayload) => void>();

    tracker.registerInteractionListener(onInteraction);
    tracker.startInteractionTracking();

    const keydown = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
    });
    document.dispatchEvent(keydown);

    const keydownEntry = createEventEntry({
      name: 'keydown',
      startTime: keydown.timeStamp,
      duration: 40,
      processingStart: keydown.timeStamp + 4,
      processingEnd: keydown.timeStamp + 20,
    });

    observerCallbacks.event?.([keydownEntry]);
    await flushFinalize();

    expect(onInteraction).toHaveBeenCalledTimes(1);
    expect(onInteraction.mock.calls[0][0].attribution.typedInput).toBe('Enter');

    observerCallbacks.event?.([
      createEventEntry({
        name: 'keyup',
        startTime: keydown.timeStamp + 30,
        duration: 20,
        processingStart: keydown.timeStamp + 34,
        processingEnd: keydown.timeStamp + 40,
      }),
    ]);
    await flushFinalize();

    expect(onInteraction).toHaveBeenCalledTimes(2);
    expect(onInteraction.mock.calls[1][0].attribution.typedInput).toBe('Enter');
    expect(onInteraction.mock.calls[1][0].attribution.typedKey).toMatchObject({
      key: 'Enter',
      code: 'Enter',
    });
    expect(onInteraction.mock.calls[1][0]).not.toHaveProperty('entries');
  });

  it('does not attach typed input to pointer interactions', async () => {
    const tracker = await loadTracker();
    const onInteraction = vi.fn<(payload: InteractionPayload) => void>();

    tracker.registerInteractionListener(onInteraction);
    tracker.startInteractionTracking();

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        bubbles: true,
      }),
    );

    observerCallbacks.event?.([createEventEntry({ name: 'click' })]);

    await flushFinalize();

    expect(onInteraction).toHaveBeenCalledTimes(1);
    expect(onInteraction.mock.calls[0][0].attribution.typedInput).toBeUndefined();
    expect(onInteraction.mock.calls[0][0].attribution.typedKey).toBeUndefined();
  });
});
