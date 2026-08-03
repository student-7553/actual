import {
  isInteractionTrackingSupported,
  registerInteractionListener,
  startInteractionTracking,
} from './interactionTracker';
import type { InteractionPayload } from './types';

export const CAPTURED_INTERACTIONS_STORAGE_KEY = 'actual-captured-interactions';

const PERSIST_INTERVAL_MS = 15_000;

const capturedInteractions: InteractionPayload[] = [];
let initialized = false;
let persistIntervalId: number | null = null;

export function getCapturedInteractions(): readonly InteractionPayload[] {
  return capturedInteractions;
}

export function persistCapturedInteractionsToLocalStorage() {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      CAPTURED_INTERACTIONS_STORAGE_KEY,
      JSON.stringify(capturedInteractions),
    );
  } catch {
    // Ignore quota and private mode errors.
  }
}

function startPersistingCapturedInteractions() {
  if (typeof window === 'undefined' || persistIntervalId !== null) {
    return;
  }

  persistIntervalId = window.setInterval(
    persistCapturedInteractionsToLocalStorage,
    PERSIST_INTERVAL_MS,
  );
}

export function initInteractionTracking() {
  if (initialized || !isInteractionTrackingSupported()) {
    return;
  }

  initialized = true;

  registerInteractionListener(interaction => {
    capturedInteractions.push(interaction);
  });

  startInteractionTracking();
  startPersistingCapturedInteractions();

  if (typeof window !== 'undefined') {
    window.__capturedInteractions = capturedInteractions;
  }
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Window {
    __capturedInteractions?: InteractionPayload[];
  }
}
