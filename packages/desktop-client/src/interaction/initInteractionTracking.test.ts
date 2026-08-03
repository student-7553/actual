import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('initInteractionTracking', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('./interactionTracker');
  });

  it('registers the listener before starting observers', async () => {
    const callOrder: string[] = [];

    vi.doMock('./interactionTracker', () => ({
      isInteractionTrackingSupported: () => true,
      registerInteractionListener: () => {
        callOrder.push('register');
      },
      startInteractionTracking: () => {
        callOrder.push('start');
        return true;
      },
    }));

    const { initInteractionTracking } = await import('./initInteractionTracking');

    initInteractionTracking();

    expect(callOrder).toEqual(['register', 'start']);
  });

  it('stores captured interactions and exposes them on window', async () => {
    let listener: ((interaction: { interactionId: number }) => void) | null =
      null;

    vi.doMock('./interactionTracker', () => ({
      isInteractionTrackingSupported: () => true,
      registerInteractionListener: (
        callback: (interaction: { interactionId: number }) => void,
      ) => {
        listener = callback;
      },
      startInteractionTracking: () => true,
    }));

    const { getCapturedInteractions, initInteractionTracking } = await import(
      './initInteractionTracking'
    );

    initInteractionTracking();
    listener?.({ interactionId: 42 });

    expect(getCapturedInteractions()).toEqual([{ interactionId: 42 }]);
    expect(window.__capturedInteractions).toBe(getCapturedInteractions());
  });

  it('persists captured interactions to localStorage every 15 seconds', async () => {
    vi.useFakeTimers();

    let listener: ((interaction: { interactionId: number }) => void) | null =
      null;

    vi.doMock('./interactionTracker', () => ({
      isInteractionTrackingSupported: () => true,
      registerInteractionListener: (
        callback: (interaction: { interactionId: number }) => void,
      ) => {
        listener = callback;
      },
      startInteractionTracking: () => true,
    }));

    const {
      CAPTURED_INTERACTIONS_STORAGE_KEY,
      getCapturedInteractions,
      initInteractionTracking,
    } = await import('./initInteractionTracking');

    initInteractionTracking();
    listener?.({ interactionId: 1 });

    expect(
      window.localStorage.getItem(CAPTURED_INTERACTIONS_STORAGE_KEY),
    ).toBeNull();

    vi.advanceTimersByTime(15_000);

    expect(
      JSON.parse(
        window.localStorage.getItem(CAPTURED_INTERACTIONS_STORAGE_KEY) ?? '[]',
      ),
    ).toEqual(getCapturedInteractions());

    listener?.({ interactionId: 2 });
    vi.advanceTimersByTime(15_000);

    expect(
      JSON.parse(
        window.localStorage.getItem(CAPTURED_INTERACTIONS_STORAGE_KEY) ?? '[]',
      ),
    ).toEqual(getCapturedInteractions());

    vi.useRealTimers();
  });
});
