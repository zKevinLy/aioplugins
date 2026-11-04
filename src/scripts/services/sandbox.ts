// Runs untrusted provider code in isolation, on the user's own machine.
//
// Layers of containment:
//  1. A hidden iframe with sandbox="allow-scripts" and NOT allow-same-origin.
//     It gets a unique opaque origin, so it cannot read this page, its
//     cookies, localStorage or session, and requests it makes do not carry
//     this site's cookies.
//  2. A Content-Security-Policy inside the iframe: no images, frames, forms
//     or other resource types; scripts only inline/blob; network only https.
//  3. The provider itself runs in a Worker inside that iframe, so it has no
//     DOM and cannot freeze the page.
//  4. A hard timeout: the iframe (and with it the Worker) is removed.
//
// The provider's own network requests are real: it may contact its servers.

import { RUNNER_SOURCE } from "./sandbox-runner.js";

export type SandboxResult =
  | { ok: true; ms: number; count: number }
  | {
      ok: false;
      kind: "load" | "error" | "network" | "timeout";
      ms?: number;
      message: string;
    };

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "worker-src blob:",
  "connect-src https:"
].join("; ");

// Runs inside the iframe. Prefers a Worker; falls back to the iframe's own
// thread if the browser refuses to start one.
const FRAME_SCRIPT = `
const execute = new Function(${JSON.stringify(RUNNER_SOURCE)} + "; return execute;")();

function runInWorker(message) {
  return new Promise((resolve, reject) => {
    const source = ${JSON.stringify(RUNNER_SOURCE)} +
      "\\nself.onmessage = async (event) => { self.postMessage(await execute(event.data.code, event.data.args)); };";
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = (event) => { event.preventDefault(); reject(new Error("worker")); };
    worker.postMessage({ code: message.code, args: message.args });
  });
}

window.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || message.type !== "run") return;

  let result;
  try {
    result = await runInWorker(message);
  } catch (error) {
    result = await execute(message.code, message.args);
  }

  parent.postMessage({ type: "result", nonce: message.nonce, result }, "*");
});
`;

function frameDocument(): string {
  // "</script" inside the string literals is escaped so it cannot end the tag early.
  const script = FRAME_SCRIPT.replace(/<\/script/gi, "<\\/script");

  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `</head><body><script>${script}</script></body></html>`;
}

export function runInSandbox(
  code: string,
  args: unknown[],
  timeoutMs: number
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const nonce = crypto.randomUUID();
    const frame = document.createElement("iframe");
    let finished = false;

    const finish = (result: SandboxResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove(); // also stops the Worker
      resolve(result);
    };

    const onMessage = (event: MessageEvent) => {
      // Only accept the answer to this run, from this frame.
      if (event.source !== frame.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;

      const message = data as { type?: unknown; nonce?: unknown; result?: SandboxResult };
      if (message.type !== "result" || message.nonce !== nonce || !message.result) return;

      finish(message.result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        kind: "timeout",
        ms: timeoutMs,
        message: `No answer after ${Math.round(timeoutMs / 1000)} seconds`
      });
    }, timeoutMs);

    window.addEventListener("message", onMessage);

    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    frame.addEventListener("load", () => {
      frame.contentWindow?.postMessage({ type: "run", nonce, code, args }, "*");
    });
    frame.srcdoc = frameDocument();

    document.body.append(frame);
  });
}
