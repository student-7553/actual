import type {
  InteractionAttribution,
  InteractionCallback,
  InteractionPayload,
  SerializedEntry,
  TypedKeyInput,
} from './types';

type PerformanceEventTimingEntry = PerformanceEntry & {
  interactionId?: number;
  processingStart: number;
  processingEnd: number;
  target?: Node;
  targetSelector?: string;
};

type LongAnimationFrameEntry = PerformanceEntry & {
  styleAndLayoutStart: number;
  scripts?: ScriptTiming[];
};

type ScriptTiming = {
  startTime: number;
  duration: number;
  forcedStyleAndLayoutDuration: number;
  [key: string]: unknown;
};

type InteractionState = {
  id: string | number;
  entries: PerformanceEventTimingEntry[];
  reportedEntryCount: number;
};

type PendingKeyInput = TypedKeyInput & {
  timeStamp: number;
  eventType: 'keydown' | 'keyup';
  consumed: boolean;
};

const KEY_INPUT_RETENTION_MS = 10_000;
const KEY_MATCH_EPSILON_MS = 0.5;

const isSupported =
  typeof PerformanceEventTiming !== 'undefined' &&
  'interactionId' in PerformanceEventTiming.prototype;

let pendingLoAFs: LongAnimationFrameEntry[] = [];
let pendingKeyInputs: PendingKeyInput[] = [];
let keyInputByEntry = new WeakMap<
  PerformanceEventTimingEntry,
  PendingKeyInput
>();
let interactions: Record<string, InteractionState> = {};
let finalizeIdleId: number | null = null;
let onInteraction: InteractionCallback | null = null;
let trackingStarted = false;
let keyListenersAttached = false;

function getNavigationEntry(): PerformanceNavigationTiming | null {
  const entries = performance.getEntriesByType('navigation');
  return entries.length ? (entries[0] as PerformanceNavigationTiming) : null;
}

function getLoadState(timestamp: number): string {
  if (document.readyState === 'loading') {
    return 'loading';
  }

  const navigationEntry = getNavigationEntry();

  if (navigationEntry) {
    if (timestamp < navigationEntry.domInteractive) {
      return 'loading';
    }
    if (
      !navigationEntry.domContentLoadedEventStart ||
      timestamp < navigationEntry.domContentLoadedEventStart
    ) {
      return 'dom-interactive';
    }
    if (!navigationEntry.domComplete || timestamp < navigationEntry.domComplete) {
      return 'dom-content-loaded';
    }
  }

  return 'complete';
}

function getSelector(node: Node): string {
  let sel = '';
  let current: Node | null = node;

  try {
    while (current && current.nodeType !== Node.DOCUMENT_NODE) {
      const el = current as Element;
      const part = el.id
        ? `#${el.id}`
        : `${el.nodeName.toLowerCase()}.${Array.from(el.classList || [])
          .sort()
          .join('.')}`;

      if (sel.length + part.length > 99) {
        return sel || part;
      }

      sel = sel ? `${part}>${sel}` : part;

      if (el.id) {
        break;
      }

      current = el.parentNode;
    }
  } catch {
    return sel;
  }

  return sel;
}

function getInteractionKey(entry: PerformanceEventTimingEntry): string | null {
  if (entry.interactionId) {
    return String(entry.interactionId);
  }
  if (entry.entryType === 'first-input') {
    return `first-input-${entry.startTime}`;
  }
  return null;
}

function getInteractionTarget(entries: PerformanceEventTimingEntry[]): string {
  for (const entry of entries) {
    if (entry.target) {
      return getSelector(entry.target);
    }
    if (entry.targetSelector) {
      return entry.targetSelector;
    }
  }

  return '';
}

function getIntersectingLoAFs(
  start: number,
  end: number,
): LongAnimationFrameEntry[] {
  const result: LongAnimationFrameEntry[] = [];

  for (const loaf of pendingLoAFs) {
    if (loaf.startTime + loaf.duration < start) {
      continue;
    }
    if (loaf.startTime > end) {
      break;
    }
    result.push(loaf);
  }

  return result;
}

function copyEntryFields(entry: object): SerializedEntry {
  const result: SerializedEntry = {};

  for (const key of Object.keys(entry)) {
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value !== 'function') {
      result[key] = value;
    }
  }

  return result;
}

function prunePendingKeyInputs(now = performance.now()) {
  pendingKeyInputs = pendingKeyInputs.filter(
    input => now - input.timeStamp <= KEY_INPUT_RETENTION_MS,
  );
}

function recordKeyInput(event: KeyboardEvent) {
  if (event.type !== 'keydown' && event.type !== 'keyup') {
    return;
  }

  pendingKeyInputs.push({
    timeStamp: event.timeStamp,
    eventType: event.type,
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
    consumed: false,
  });
  prunePendingKeyInputs(event.timeStamp);
}

function findKeyInputForEntry(
  entry: PerformanceEventTimingEntry,
): PendingKeyInput | null {
  if (entry.name !== 'keydown' && entry.name !== 'keyup') {
    return null;
  }

  const cached = keyInputByEntry.get(entry);
  if (cached) {
    return cached;
  }

  let bestMatch: PendingKeyInput | null = null;
  let bestDelta = Infinity;

  for (const input of pendingKeyInputs) {
    if (input.consumed || input.eventType !== entry.name) {
      continue;
    }

    const delta = Math.abs(input.timeStamp - entry.startTime);
    if (delta <= KEY_MATCH_EPSILON_MS && delta < bestDelta) {
      bestMatch = input;
      bestDelta = delta;
    }
  }

  if (bestMatch) {
    bestMatch.consumed = true;
    keyInputByEntry.set(entry, bestMatch);
  }

  return bestMatch;
}

function serializeEventTimingEntry(
  entry: PerformanceEventTimingEntry,
): SerializedEntry {
  // PerformanceEntry fields are often prototype getters, so Object.keys alone
  // can produce empty objects. Always copy the Event Timing fields we need.
  const serialized: SerializedEntry = {
    name: entry.name,
    entryType: entry.entryType,
    startTime: entry.startTime,
    duration: entry.duration,
    processingStart: entry.processingStart,
    processingEnd: entry.processingEnd,
    interactionId: entry.interactionId,
    ...copyEntryFields(entry),
  };

  if (entry.target) {
    serialized.targetSelector = getSelector(entry.target);
  } else if (entry.targetSelector) {
    serialized.targetSelector = entry.targetSelector;
  }

  const keyInput = findKeyInputForEntry(entry);
  if (keyInput) {
    serialized.key = keyInput.key;
    serialized.code = keyInput.code;
    serialized.ctrlKey = keyInput.ctrlKey;
    serialized.altKey = keyInput.altKey;
    serialized.shiftKey = keyInput.shiftKey;
    serialized.metaKey = keyInput.metaKey;
    serialized.repeat = keyInput.repeat;
  }

  return serialized;
}

function serializeScriptTiming(script: ScriptTiming | null | undefined) {
  return script ? copyEntryFields(script) : null;
}

function serializeLongAnimationFrameEntry(entry: LongAnimationFrameEntry) {
  const serialized = copyEntryFields(entry) as SerializedEntry;

  if (entry.scripts?.length) {
    serialized.scripts = entry.scripts.map(serializeScriptTiming);
  }

  return serialized;
}

function getTypedInputFromEntries(
  processedEventEntries: SerializedEntry[],
): { typedInput: string; typedKey: TypedKeyInput } | null {
  const typedEntry =
    processedEventEntries.find(
      entry => entry.name === 'keydown' && typeof entry.key === 'string',
    ) ?? processedEventEntries.find(entry => typeof entry.key === 'string');

  if (!typedEntry || typeof typedEntry.key !== 'string') {
    return null;
  }

  return {
    typedInput: typedEntry.key,
    typedKey: {
      key: typedEntry.key,
      code: String(typedEntry.code ?? ''),
      ctrlKey: Boolean(typedEntry.ctrlKey),
      altKey: Boolean(typedEntry.altKey),
      shiftKey: Boolean(typedEntry.shiftKey),
      metaKey: Boolean(typedEntry.metaKey),
      repeat: Boolean(typedEntry.repeat),
    },
  };
}

function buildAttribution(
  entries: PerformanceEventTimingEntry[],
  serializedByEntry: Map<PerformanceEventTimingEntry, SerializedEntry>,
): InteractionAttribution {
  const firstEntry = entries[0];
  let processingStart = Infinity;
  let processingEnd = 0;
  let nextPaintTime = 0;
  const interactionTime = firstEntry.startTime;

  for (const entry of entries) {
    processingStart = Math.min(processingStart, entry.processingStart);
    processingEnd = Math.max(processingEnd, entry.processingEnd);
    nextPaintTime = Math.max(nextPaintTime, entry.startTime + entry.duration);
  }

  nextPaintTime = Math.max(nextPaintTime, processingStart);
  processingEnd = Math.min(processingEnd, nextPaintTime);

  const sortedEntries = entries
    .slice()
    .sort((a, b) => a.processingStart - b.processingStart);
  const processedEventEntries = sortedEntries.map(
    entry => serializedByEntry.get(entry) ?? serializeEventTimingEntry(entry),
  );

  const inputDelay = processingStart - interactionTime;
  const presentationDelay = nextPaintTime - processingEnd;
  const longAnimationFrameEntries = getIntersectingLoAFs(
    interactionTime,
    processingEnd,
  );
  const interactionType =
    firstEntry.name.indexOf('key') === 0 ? 'keyboard' : 'pointer';
  const typedInput =
    interactionType === 'keyboard'
      ? getTypedInputFromEntries(processedEventEntries)
      : null;

  const attribution: InteractionAttribution = {
    interactionTarget: getInteractionTarget(sortedEntries),
    interactionType,
    interactionTime,
    nextPaintTime,
    inputDelay,
    processingDuration: processingEnd - processingStart,
    presentationDelay,
    loadState: getLoadState(interactionTime),
    ...(typedInput ?? {}),
    longAnimationFrameEntries:
      longAnimationFrameEntries.map(serializeLongAnimationFrameEntry),
    longestScript: null,
  };

  if (!longAnimationFrameEntries.length) {
    return attribution;
  }

  let totalScriptDuration = 0;
  let totalStyleAndLayoutDuration = 0;
  let totalPaintDuration = 0;
  let longestScriptDuration = 0;
  let longestScriptEntry: ScriptTiming | null = null;
  let longestScriptSubpart: string | null = null;

  for (const loafEntry of longAnimationFrameEntries) {
    totalStyleAndLayoutDuration +=
      loafEntry.startTime + loafEntry.duration - loafEntry.styleAndLayoutStart;

    if (!loafEntry.scripts) {
      continue;
    }

    for (const script of loafEntry.scripts) {
      const scriptEndTime = script.startTime + script.duration;
      if (scriptEndTime < interactionTime) {
        continue;
      }

      const intersectingScriptDuration =
        scriptEndTime - Math.max(interactionTime, script.startTime);
      const intersectingForceStyleAndLayoutDuration = script.duration
        ? (intersectingScriptDuration / script.duration) *
        script.forcedStyleAndLayoutDuration
        : 0;

      totalScriptDuration +=
        intersectingScriptDuration - intersectingForceStyleAndLayoutDuration;
      totalStyleAndLayoutDuration += intersectingForceStyleAndLayoutDuration;

      if (intersectingScriptDuration > longestScriptDuration) {
        longestScriptSubpart =
          script.startTime < interactionTime + inputDelay
            ? 'input-delay'
            : script.startTime >=
              interactionTime + inputDelay + attribution.processingDuration
              ? 'presentation-delay'
              : 'processing-duration';
        longestScriptEntry = script;
        longestScriptDuration = intersectingScriptDuration;
      }
    }
  }

  const lastLoAF = longAnimationFrameEntries[longAnimationFrameEntries.length - 1];
  const lastLoAFEndTime = lastLoAF ? lastLoAF.startTime + lastLoAF.duration : 0;

  if (
    lastLoAFEndTime >=
    interactionTime + inputDelay + attribution.processingDuration
  ) {
    totalPaintDuration = nextPaintTime - lastLoAFEndTime;
  }

  if (longestScriptEntry && longestScriptSubpart) {
    attribution.longestScript = {
      subpart: longestScriptSubpart,
      intersectingDuration: longestScriptDuration,
      entry: serializeScriptTiming(longestScriptEntry),
    };
  }

  attribution.totalScriptDuration = totalScriptDuration;
  attribution.totalStyleAndLayoutDuration = totalStyleAndLayoutDuration;
  attribution.totalPaintDuration = totalPaintDuration;
  attribution.totalUnattributedDuration =
    nextPaintTime -
    interactionTime -
    totalScriptDuration -
    totalStyleAndLayoutDuration -
    totalPaintDuration;

  return attribution;
}

function getInteractionLatency(entries: PerformanceEventTimingEntry[]): number {
  let latency = 0;

  for (const entry of entries) {
    latency = Math.max(latency, entry.duration);
  }

  return latency;
}

function finalizeInteractions() {
  finalizeIdleId = null;

  for (const key of Object.keys(interactions)) {
    const interaction = interactions[key];

    if (
      !interaction.entries.length ||
      interaction.entries.length === interaction.reportedEntryCount
    ) {
      continue;
    }

    interaction.entries.sort((a, b) => a.startTime - b.startTime);

    // Serialize once so key matching is consumed a single time per entry
    // (needed for typedInput), without emitting the raw entry arrays.
    const serializedByEntry = new Map(
      interaction.entries.map(entry => [
        entry,
        serializeEventTimingEntry(entry),
      ]),
    );
    const attribution = buildAttribution(
      interaction.entries,
      serializedByEntry,
    );
    const latency = getInteractionLatency(interaction.entries);
    interaction.reportedEntryCount = interaction.entries.length;

    onInteraction?.({
      name: 'INTERACTION',
      interactionId: interaction.id,
      value: latency,
      attribution,
    });
  }

  const now = performance.now();
  pendingLoAFs = pendingLoAFs.filter(loaf => loaf.startTime > now - 5000);
  prunePendingKeyInputs(now);
}

function scheduleFinalize() {
  const idleCallback =
    window.requestIdleCallback ||
    ((callback: IdleRequestCallback) => window.setTimeout(callback, 1));
  const cancelIdle = window.cancelIdleCallback || window.clearTimeout;

  if (finalizeIdleId !== null) {
    cancelIdle(finalizeIdleId);
  }

  finalizeIdleId = idleCallback(finalizeInteractions);
}

function recordEntry(entry: PerformanceEventTimingEntry) {
  const key = getInteractionKey(entry);

  if (!key) {
    return;
  }

  if (!interactions[key]) {
    interactions[key] = {
      id: entry.interactionId || key,
      entries: [],
      reportedEntryCount: 0,
    };
  }

  interactions[key].entries.push(entry);
  scheduleFinalize();
}

type ObserverInit = PerformanceObserverInit & {
  durationThreshold?: number;
};

function observe(
  type: string,
  callback: (entries: PerformanceEntry[]) => void,
  options?: ObserverInit,
): PerformanceObserver | null {
  try {
    if (
      PerformanceObserver.supportedEntryTypes &&
      !PerformanceObserver.supportedEntryTypes.includes(type)
    ) {
      return null;
    }

    const observer = new PerformanceObserver((list) => {
      callback(list.getEntries());
    });

    const observeOptions: ObserverInit = {
      type,
      buffered: true,
      ...options,
    };

    observer.observe(observeOptions);
    return observer;
  } catch {
    return null;
  }
}

function startKeyInputCapture() {
  if (keyListenersAttached || typeof document === 'undefined') {
    return;
  }

  // Capture phase so we still see keys even if handlers stop propagation.
  // Event Timing's startTime matches KeyboardEvent.timeStamp, which lets us
  // attach the typed key to the correct performance entry.
  document.addEventListener('keydown', recordKeyInput, true);
  document.addEventListener('keyup', recordKeyInput, true);
  keyListenersAttached = true;
}

function startObservers() {
  startKeyInputCapture();

  observe('long-animation-frame', entries => {
    pendingLoAFs = pendingLoAFs.concat(entries as LongAnimationFrameEntry[]);
  });

  const eventObserver = observe(
    'event',
    entries => {
      for (const entry of entries) {
        recordEntry(entry as PerformanceEventTimingEntry);
      }
    },
    { durationThreshold: 0 },
  );

  if (eventObserver) {
    eventObserver.observe({ type: 'first-input', buffered: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      finalizeInteractions();
    }
  });
}

export function isInteractionTrackingSupported() {
  return isSupported;
}

export function registerInteractionListener(callback: InteractionCallback) {
  const previous = onInteraction;

  onInteraction = (payload: InteractionPayload) => {
    previous?.(payload);
    callback(payload);
  };
}

export function startInteractionTracking() {
  if (!isSupported || trackingStarted) {
    return trackingStarted;
  }

  startObservers();
  trackingStarted = true;
  return true;
}

export function resetInteractionTracker() {
  const cancelIdle = window.cancelIdleCallback || window.clearTimeout;

  if (finalizeIdleId !== null) {
    cancelIdle(finalizeIdleId);
    finalizeIdleId = null;
  }

  if (keyListenersAttached && typeof document !== 'undefined') {
    document.removeEventListener('keydown', recordKeyInput, true);
    document.removeEventListener('keyup', recordKeyInput, true);
    keyListenersAttached = false;
  }

  interactions = {};
  pendingLoAFs = [];
  pendingKeyInputs = [];
  keyInputByEntry = new WeakMap();
  trackingStarted = false;
}
