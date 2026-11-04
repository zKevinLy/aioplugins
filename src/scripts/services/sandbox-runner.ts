// The code that runs a provider. It is shipped to the sandbox as a string
// (not imported there), so it must be plain JavaScript that depends on
// nothing outside itself. Do not use backticks or dollar-brace in it.
//
// `execute` loads the provider source with a minimal CommonJS surface and
// calls getStreams once. It deliberately has no access to the page: it runs
// in a Worker inside a sandboxed iframe (see sandbox.ts).

export const RUNNER_SOURCE = String.raw`
function describe(error) {
  return String((error && error.message) || error).slice(0, 200);
}

function isNetworkError(error) {
  return error instanceof TypeError &&
    /fetch|network|load failed|cors/i.test(String(error.message));
}

async function execute(code, args) {
  const module = { exports: {} };
  const silent = function () {};
  const consoleStub = { log: silent, info: silent, warn: silent, error: silent, debug: silent };
  const requireStub = function (name) {
    throw new Error("require('" + name + "') is not available in the speed check");
  };

  let loaded;
  try {
    const factory = new Function(
      "module", "exports", "require", "console",
      code + "\n;return typeof getStreams === 'function' ? getStreams : undefined;"
    );
    loaded = factory(module, module.exports, requireStub, consoleStub);
  } catch (error) {
    return { ok: false, kind: "load", message: describe(error) };
  }

  const getStreams = (module.exports && module.exports.getStreams) || loaded;

  if (typeof getStreams !== "function") {
    return { ok: false, kind: "load", message: "The plugin does not provide getStreams" };
  }

  const started = performance.now();

  try {
    const result = await getStreams.apply(module.exports, args);
    const ms = Math.round(performance.now() - started);

    if (!Array.isArray(result)) {
      return { ok: false, kind: "error", ms: ms, message: "getStreams did not return a list" };
    }

    return { ok: true, ms: ms, count: result.length };
  } catch (error) {
    return {
      ok: false,
      kind: isNetworkError(error) ? "network" : "error",
      ms: Math.round(performance.now() - started),
      message: describe(error)
    };
  }
}
`;
