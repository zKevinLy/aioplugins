// Checks, from inside Nuvio's plugin runtime, whether a stream URL looks
// playable and seekable.
//
// AIOPlugins itself never plays or downloads media. This function is copied
// into the generated plugin wrapper with `Function.prototype.toString` and
// runs in Nuvio, so the probe request comes from the viewer's device, not from
// the AIOPlugins server. Like `isUnknownValue`, it must stay self-contained:
// no imports and no references to anything outside its own body.
//
// It sends one small ranged GET (`Range: bytes=0-31`) and reads, at most,
// those first bytes. Only definite problems mark a stream as unusable. A
// timeout, a network error, a 5xx, a rate limit, or a missing `fetch` leaves
// the verdict unknown (`null`), and unknown streams are always kept, so a
// flaky host never empties the list.

export interface StreamProbeResult {
  /** false when the URL clearly cannot be played; null when unsure. */
  playable: boolean | null;
  /** false when the server clearly ignores byte ranges; null when unsure. */
  seekable: boolean | null;
  reason: string;
}

export async function probeStreamUrl(
  url: string,
  headers: Record<string, string> | null | undefined,
  timeoutMs: number
): Promise<StreamProbeResult> {
  const unknown = (reason: string): StreamProbeResult =>
    ({ playable: null, seekable: null, reason });

  if (typeof fetch !== "function") return unknown("fetch unavailable");
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return unknown("not an http(s) URL");

  // Send the provider's own headers, but own the Range header.
  const requestHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers && typeof headers === "object" ? headers : {})) {
    if (typeof value === "string" && name.toLowerCase() !== "range") requestHeaders[name] = value;
  }
  requestHeaders.Range = "bytes=0-31";

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const probe = async (): Promise<StreamProbeResult> => {
    const response = await fetch(url, {
      method: "GET",
      headers: requestHeaders,
      redirect: "follow",
      ...(controller ? { signal: controller.signal } : {})
    });

    const status = response.status;
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const contentRange = response.headers.get("content-range") || "";
    const acceptRanges = (response.headers.get("accept-ranges") || "").toLowerCase();
    const lengthHeader = response.headers.get("content-length");
    const length = lengthHeader === null || lengthHeader.trim() === "" ? NaN : Number(lengthHeader);

    // Busy or blocking responses say nothing about the file itself.
    if (status === 408 || status === 425 || status === 429) return unknown(`HTTP ${status}`);
    if (status >= 500 || (status >= 300 && status < 400)) return unknown(`HTTP ${status}`);
    // Missing, forbidden, gone, or an empty file (416 for a zero-byte file).
    if (status >= 400) return { playable: false, seekable: null, reason: `HTTP ${status}` };

    // Error pages are served with a 200 more often than you would hope.
    if (/^(?:text\/html|application\/(?:json|xml|xhtml\+xml)|text\/xml)\b/.test(type)) {
      return { playable: false, seekable: null, reason: `content-type ${type.split(";")[0]}` };
    }

    // HLS playlists are played by segment; byte ranges do not apply to them.
    if (/mpegurl/.test(type) || /\.m3u8(?:[?#]|$)/i.test(url)) {
      return { playable: true, seekable: true, reason: "HLS playlist" };
    }

    const ranged = status === 206 && /^bytes\s+\d+-\d+\/(?:\d+|\*)/i.test(contentRange);
    // A 200 can still be seekable: the server may have ignored a range that
    // started at the beginning of the file but still advertise support.
    const seekable = ranged || (status === 200 && /\bbytes\b/.test(acceptRanges));

    if (status === 200 && length === 0) {
      return { playable: false, seekable: false, reason: "empty response" };
    }

    // Only a ranged answer is small enough to read safely. A 200 may be the
    // whole file, so its body is never read, and the request is aborted below.
    if (status === 206) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      let first = 0;
      while (first < bytes.length && (bytes[first] === 0x20 || bytes[first] === 0x0a || bytes[first] === 0x0d || bytes[first] === 0x09 || bytes[first] === 0xef || bytes[first] === 0xbb || bytes[first] === 0xbf)) first++;
      const lead = bytes[first];

      // "<" starts HTML or XML and "{" or "[" starts JSON; no media container does.
      if (lead === 0x3c || lead === 0x7b || lead === 0x5b) {
        return { playable: false, seekable, reason: "response body is text, not media" };
      }
    }

    return { playable: true, seekable, reason: seekable ? "ok" : "server does not support byte ranges" };
  };

  const timeout = new Promise<StreamProbeResult>(resolve => {
    timer = setTimeout(() => resolve(unknown("timed out")), timeoutMs);
  });

  try {
    return await Promise.race([probe(), timeout]);
  } catch {
    return unknown("request failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Drop the connection so a server that ignored the range stops sending.
    try { controller?.abort(); } catch { /* nothing to abort */ }
  }
}

export interface StreamSpeedResult {
  /** false when the URL clearly cannot be played; null when unsure. */
  playable: boolean | null;
  /** false when the server clearly ignores byte ranges; null when unsure. */
  seekable: boolean | null;
  /** Throughput of one small sample; null when it could not be measured. */
  bytesPerSecond: number | null;
  reason: string;
}

/**
 * Downloads one small sample from the start of a stream and times it, so
 * streams that tie on everything else can be put in order of how quickly they
 * deliver data (a slow host is the one that buffers). Like `probeStreamUrl`
 * this runs inside Nuvio, is self-contained, and never throws: anything it
 * cannot judge comes back with `bytesPerSecond: null`.
 */
export async function measureStreamSpeed(
  url: string,
  headers: Record<string, string> | null | undefined,
  timeoutMs: number,
  sampleBytes: number
): Promise<StreamSpeedResult> {
  const unknown = (reason: string): StreamSpeedResult =>
    ({ playable: null, seekable: null, bytesPerSecond: null, reason });

  if (typeof fetch !== "function") return unknown("fetch unavailable");
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return unknown("not an http(s) URL");

  const requestHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers && typeof headers === "object" ? headers : {})) {
    if (typeof value === "string" && name.toLowerCase() !== "range") requestHeaders[name] = value;
  }
  requestHeaders.Range = `bytes=0-${Math.max(1, Math.floor(sampleBytes)) - 1}`;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const measure = async (): Promise<StreamSpeedResult> => {
    const started = Date.now();
    const response = await fetch(url, {
      method: "GET",
      headers: requestHeaders,
      redirect: "follow",
      ...(controller ? { signal: controller.signal } : {})
    });

    const status = response.status;
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const contentRange = response.headers.get("content-range") || "";
    const acceptRanges = (response.headers.get("accept-ranges") || "").toLowerCase();

    if (status === 408 || status === 425 || status === 429) return unknown(`HTTP ${status}`);
    if (status >= 500 || (status >= 300 && status < 400)) return unknown(`HTTP ${status}`);
    if (status >= 400) return { playable: false, seekable: null, bytesPerSecond: null, reason: `HTTP ${status}` };

    if (/^(?:text\/html|application\/(?:json|xml|xhtml\+xml)|text\/xml)\b/.test(type)) {
      return { playable: false, seekable: null, bytesPerSecond: null, reason: `content-type ${type.split(";")[0]}` };
    }

    // HLS is played by segment; one playlist download says nothing about speed.
    if (/mpegurl/.test(type) || /\.m3u8(?:[?#]|$)/i.test(url)) {
      return { playable: true, seekable: true, bytesPerSecond: null, reason: "HLS playlist" };
    }

    const ranged = status === 206 && /^bytes\s+\d+-\d+\/(?:\d+|\*)/i.test(contentRange);
    const seekable = ranged || (status === 200 && /\bbytes\b/.test(acceptRanges));

    const bytes = new Uint8Array(await response.arrayBuffer());
    const elapsed = Math.max(1, Date.now() - started);

    if (bytes.length === 0) {
      return { playable: false, seekable: false, bytesPerSecond: null, reason: "empty response" };
    }

    let first = 0;
    while (first < bytes.length && (bytes[first] === 0x20 || bytes[first] === 0x0a || bytes[first] === 0x0d || bytes[first] === 0x09 || bytes[first] === 0xef || bytes[first] === 0xbb || bytes[first] === 0xbf)) first++;
    const lead = bytes[first];
    if (lead === 0x3c || lead === 0x7b || lead === 0x5b) {
      return { playable: false, seekable, bytesPerSecond: null, reason: "response body is text, not media" };
    }

    return {
      playable: true,
      seekable,
      bytesPerSecond: Math.round((bytes.length * 1000) / elapsed),
      reason: "ok"
    };
  };

  const timeout = new Promise<StreamSpeedResult>(resolve => {
    timer = setTimeout(() => resolve(unknown("timed out")), timeoutMs);
  });

  try {
    return await Promise.race([measure(), timeout]);
  } catch {
    return unknown("request failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { controller?.abort(); } catch { /* nothing to abort */ }
  }
}
