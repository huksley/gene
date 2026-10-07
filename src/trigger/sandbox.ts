/**
 * Runs a compiled trigger check in a QuickJS sandbox. The check is untrusted (compiled
 * from ticket prose), so the sandbox is the security boundary: a fresh runtime per run,
 * no ambient globals, and only the `gene` API — whose capabilities are host functions
 * injected by the caller (see host.ts for the real ones). Knows nothing about programs.
 */
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSSyncVariant,
  type QuickJSWASMModule
} from "quickjs-emscripten-core";
import * as releaseSyncModule from "@jitl/quickjs-wasmfile-release-sync";
import { inSea, wasmAsset } from "../sea-assets.ts";

export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
export type FetchResult = { status: number; headers: Record<string, string>; text: string };
export type ExecResult = { code: number; stdout: string; stderr: string };

export type CheckHost = {
  cron: (expr: string, tz?: string) => boolean;
  fetch: (url: string, init: FetchInit) => Promise<FetchResult>;
  exec: (cmd: string, args: string[]) => Promise<ExecResult>;
  now: () => Date;
};

export type CheckLimits = {
  memoryBytes: number;
  stackBytes: number;
  cpuMs: number;
  wallMs: number;
  maxCalls: number;
  maxStateBytes: number;
  maxReason: number;
  maxLogLines: number;
};

export const DEFAULT_LIMITS: CheckLimits = {
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 512 * 1024,
  cpuMs: 1_000,
  wallMs: 60_000,
  maxCalls: 10,
  maxStateBytes: 16 * 1024,
  maxReason: 500,
  maxLogLines: 20
};

export type CheckOutcome =
  | { ok: true; fire: boolean; reason?: string; state: unknown; logs: string[]; usedIo: boolean }
  | { ok: false; error: string; thrown: boolean; logs: string[]; usedIo: boolean };

// The package's CJS typings make TS see the default import as the module namespace; at
// runtime (ESM) the variant is the default export. Unwrap either shape.
const releaseSync = ((releaseSyncModule as unknown as { default?: QuickJSSyncVariant }).default ??
  releaseSyncModule) as unknown as QuickJSSyncVariant;

let modulePromise: Promise<QuickJSWASMModule> | null = null;

/** Load the QuickJS WASM once per process — from the SEA asset in the binary, else from node_modules. */
const loadQuickJS = (): Promise<QuickJSWASMModule> => {
  modulePromise ??= newQuickJSWASMModuleFromVariant(
    inSea() ? newVariant(releaseSync, { wasmModule: wasmAsset("quickjs.wasm") }) : releaseSync
  );
  return modulePromise;
};

// The in-sandbox side of the `gene` API. Host functions speak JSON strings so no
// handle juggling leaks into user code; `__host_async` returns a promise.
const PRELUDE = `
  const __call = async (name, args) => JSON.parse(await __host_async(name, JSON.stringify(args)));
  globalThis.gene = {
    cron: (expr, opts) => __host_cron(String(expr), opts && opts.tz ? String(opts.tz) : ""),
    fetch: async (url, opts) => {
      const r = await __call("fetch", [String(url), opts || {}]);
      return { status: r.status, headers: r.headers, text: r.text, json: () => JSON.parse(r.text) };
    },
    exec: (cmd, args) => __call("exec", [String(cmd), (args || []).map(String)]),
    now: () => __host_now(),
    log: msg => __host_log(String(msg)),
    state: JSON.parse(__initial_state)
  };
`;

const RUNNER = `
  (async () => {
    if (typeof check !== "function") throw { __gene: "check is not a function" };
    let result;
    try {
      result = await check(gene);
    } catch (error) {
      throw { __thrown: String(error && error.message ? error.message : error) };
    }
    let state;
    try {
      state = JSON.stringify(gene.state === undefined ? null : gene.state);
    } catch (error) {
      throw { __gene: "gene.state is not JSON-serialisable" };
    }
    return JSON.stringify({ result, state });
  })()
`;

const SHAPE_ERROR = "check must return { fire: boolean, reason?: string }";

export const runCheck = async (
  code: string,
  host: CheckHost,
  state: unknown,
  limits: CheckLimits = DEFAULT_LIMITS
): Promise<CheckOutcome> => {
  const QuickJS = await loadQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);

  // CPU budget counts only synchronous JS slices; awaiting host calls is excluded.
  let cpuLeft = limits.cpuMs;
  let sliceStart = 0;
  let cpuExceeded = false;
  runtime.setInterruptHandler(() => {
    if (performance.now() - sliceStart > cpuLeft) {
      cpuExceeded = true;
      return true;
    }
    return false;
  });
  const slice = <T>(fn: () => T): T => {
    sliceStart = performance.now();
    try {
      return fn();
    } finally {
      cpuLeft -= performance.now() - sliceStart;
    }
  };

  const ctx: QuickJSContext = runtime.newContext();
  const logs: string[] = [];
  let calls = 0;
  let usedIo = false;
  const inflight = new Set<Promise<void>>();
  // Deferreds handed to the sandbox for host calls. One still pending when the run ends
  // (wall-clock timeout) must be disposed before the context, or QuickJS aborts on free.
  const deferreds = new Set<QuickJSDeferredPromise>();
  const fail = (error: string, thrown = false): CheckOutcome => ({ ok: false, error, thrown, logs, usedIo });

  try {
    const fn = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle | undefined): void => {
      const handle = ctx.newFunction(name, impl);
      ctx.setProp(ctx.global, name, handle);
      handle.dispose();
    };
    fn("__host_cron", (expr, tz) => {
      const tzValue = ctx.getString(tz);
      return host.cron(ctx.getString(expr), tzValue === "" ? undefined : tzValue) ? ctx.true : ctx.false;
    });
    fn("__host_now", () => ctx.newString(host.now().toISOString()));
    fn("__host_log", msg => {
      if (logs.length < limits.maxLogLines) logs.push(ctx.getString(msg));
      return undefined;
    });
    fn("__host_async", (nameHandle, argsHandle) => {
      const name = ctx.getString(nameHandle);
      const args = JSON.parse(ctx.getString(argsHandle)) as unknown[];
      const deferred = ctx.newPromise();
      deferreds.add(deferred);
      calls += 1;
      usedIo = true;
      const work: Promise<unknown> =
        calls > limits.maxCalls
          ? Promise.reject(new Error(`more than ${limits.maxCalls} fetch/exec calls`))
          : name === "fetch"
            ? host.fetch(String(args[0]), (args[1] ?? {}) as FetchInit)
            : host.exec(String(args[0]), (args[1] ?? []) as string[]);
      const settled = work.then(
        value => {
          if (!ctx.alive || !deferred.alive) return;
          const h = ctx.newString(JSON.stringify(value));
          deferred.resolve(h);
          h.dispose();
        },
        (error: unknown) => {
          if (!ctx.alive || !deferred.alive) return;
          const h = ctx.newError(error instanceof Error ? error.message : String(error));
          deferred.reject(h);
          h.dispose();
        }
      );
      const tracked = settled.finally(() => inflight.delete(tracked));
      inflight.add(tracked);
      return deferred.handle;
    });
    const stateHandle = ctx.newString(JSON.stringify(state ?? null));
    ctx.setProp(ctx.global, "__initial_state", stateHandle);
    stateHandle.dispose();

    const prelude = slice(() => ctx.evalCode(PRELUDE, "prelude.js"));
    if (prelude.error) {
      const err = ctx.dump(prelude.error);
      prelude.error.dispose();
      return fail(`prelude failed: ${JSON.stringify(err)}`);
    }
    prelude.value.dispose();

    const loaded = slice(() => ctx.evalCode(code, "check.js"));
    if (loaded.error) {
      const err = ctx.dump(loaded.error) as { message?: string } | string;
      loaded.error.dispose();
      if (cpuExceeded) return fail("check interrupted: CPU limit exceeded");
      return fail(`load failed: ${typeof err === "string" ? err : err?.message ?? JSON.stringify(err)}`);
    }
    loaded.value.dispose();

    const started = Date.now();
    const run = slice(() => ctx.evalCode(RUNNER, "runner.js"));
    if (run.error) {
      run.error.dispose();
      return fail(cpuExceeded ? "check interrupted: CPU limit exceeded" : "runner failed");
    }
    const promise = run.value;
    try {
      for (;;) {
        const jobs = slice(() => runtime.executePendingJobs());
        if (jobs.error) {
          jobs.error.dispose();
          return fail(cpuExceeded ? "check interrupted: CPU limit exceeded" : "check failed while running jobs");
        }
        if (cpuExceeded) return fail("check interrupted: CPU limit exceeded");
        const st = ctx.getPromiseState(promise);
        if (st.type === "fulfilled") {
          const json = ctx.getString(st.value);
          st.value.dispose();
          return finish(json);
        }
        if (st.type === "rejected") {
          const err = ctx.dump(st.error) as { __gene?: string; __thrown?: string; message?: string } | string;
          st.error.dispose();
          if (cpuExceeded) return fail("check interrupted: CPU limit exceeded");
          if (typeof err === "object" && err?.__gene) return fail(err.__gene);
          // Running out of memory surfaces inside the check as an InternalError — a limit, not the check's own throw.
          if (typeof err === "object" && err?.__thrown !== undefined) return fail(err.__thrown, !/out of memory/i.test(err.__thrown));
          return fail(typeof err === "string" ? err : err?.message ?? "check failed");
        }
        if (inflight.size === 0) return fail("check did not settle (awaited a promise nothing resolves)");
        const left = limits.wallMs - (Date.now() - started);
        if (left <= 0) return fail(`wall clock limit (${limits.wallMs} ms) exceeded`);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          Promise.race(inflight).then(() => false),
          new Promise<boolean>(resolve => {
            timer = setTimeout(() => resolve(true), left);
          })
        ]);
        clearTimeout(timer);
        if (timedOut) return fail(`wall clock limit (${limits.wallMs} ms) exceeded`);
      }
    } finally {
      promise.dispose();
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    for (const deferred of deferreds) if (deferred.alive) deferred.dispose();
    try {
      ctx.dispose();
      runtime.dispose();
    } catch {
      // A failed free can leave the WASM module unusable; load a fresh one next run.
      modulePromise = null;
    }
  }

  function finish(json: string): CheckOutcome {
    const { result, state: stateJson } = JSON.parse(json) as { result: unknown; state: string };
    if (
      result === null ||
      typeof result !== "object" ||
      typeof (result as { fire?: unknown }).fire !== "boolean" ||
      ((result as { reason?: unknown }).reason !== undefined && typeof (result as { reason?: unknown }).reason !== "string")
    ) {
      return fail(SHAPE_ERROR);
    }
    if (Buffer.byteLength(stateJson) > limits.maxStateBytes) {
      return fail(`gene.state is larger than ${limits.maxStateBytes} bytes`);
    }
    const { fire, reason } = result as { fire: boolean; reason?: string };
    return {
      ok: true,
      fire,
      reason: reason === undefined ? undefined : reason.slice(0, limits.maxReason),
      state: JSON.parse(stateJson),
      logs,
      usedIo
    };
  }
};
