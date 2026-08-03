export type SerializedEntry = Record<string, unknown>;

export type TypedKeyInput = {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
};

export type LongestScriptAttribution = {
  subpart: string;
  intersectingDuration: number;
  entry: SerializedEntry | null;
};

export type InteractionAttribution = {
  interactionTarget: string;
  interactionType: 'keyboard' | 'pointer';
  interactionTime: number;
  nextPaintTime: number;
  inputDelay: number;
  processingDuration: number;
  presentationDelay: number;
  loadState: string;
  /** Key pressed for keyboard interactions (`KeyboardEvent.key`). */
  typedInput?: string;
  /** Full key details from the initiating keydown, when available. */
  typedKey?: TypedKeyInput;
  longAnimationFrameEntries: SerializedEntry[];
  longestScript: LongestScriptAttribution | null;
  totalScriptDuration?: number;
  totalStyleAndLayoutDuration?: number;
  totalPaintDuration?: number;
  totalUnattributedDuration?: number;
};

export type InteractionPayload = {
  name: 'INTERACTION';
  interactionId: string | number;
  value: number;
  attribution: InteractionAttribution;
};

export type InteractionCallback = (payload: InteractionPayload) => void;
