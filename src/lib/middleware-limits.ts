// Limits shared by the server and the browser editor, so a row the editor
// lets you add is never silently dropped when it is saved.

export const MAX_FILTERS = 30;
export const MAX_SORTS = 5;

// Bounds for the "drop streams that cannot play" check (on unless saved off). The wait is
// per stream URL; the server clamps whatever a saved profile contains.
export const MIN_PROBE_TIMEOUT_MS = 1000;
export const MAX_PROBE_TIMEOUT_MS = 15000;

export const DEFAULT_PROBE_SETTINGS = {
  enabled: true,
  requireSeekable: true,
  timeoutMs: 5000
};

// "Best stream first": among streams the sort levels cannot tell apart, the
// fastest-loading ones go first. Measured in Nuvio, on the viewer's device.
// `perQuality` caps how many streams of one resolution a plugin returns
// (0 = no cap); it applies after sorting, so the kept ones are the best ones.
export const MAX_PER_QUALITY = 20;

export const DEFAULT_RANKING_SETTINGS = {
  preferFastest: true,
  perQuality: 0
};

// Bounds for the speed check. Nuvio TV runs plugin network calls one at a
// time and cannot interrupt one that is in progress, so the work is capped by
// count and by a total time budget that is checked between measurements.
export const SPEED_SAMPLE_BYTES = 128 * 1024;
export const SPEED_TIMEOUT_MS = 4000;
export const SPEED_BUDGET_MS = 6000;
export const SPEED_MAX_PER_GROUP = 8;
export const SPEED_MAX_TOTAL = 24;
