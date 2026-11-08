// Limits shared by the server and the browser editor, so a row the editor
// lets you add is never silently dropped when it is saved.

export const MAX_FILTERS = 30;
export const MAX_SORTS = 5;

// Bounds for the optional "drop streams that cannot play" check. The wait is
// per stream URL; the server clamps whatever a saved profile contains.
export const MIN_PROBE_TIMEOUT_MS = 1000;
export const MAX_PROBE_TIMEOUT_MS = 15000;

export const DEFAULT_PROBE_SETTINGS = {
  enabled: false,
  requireSeekable: true,
  timeoutMs: 5000
};
