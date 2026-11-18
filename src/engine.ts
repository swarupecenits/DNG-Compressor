/** Downloads the libjxl WebAssembly module once and checks the browser can run it. */

import wasmUrl from "./wasm/jxl_tile.wasm?url";

export class EngineError extends Error {
  constructor(
    message: string,
    /** True when retrying can't help (the browser lacks a required feature). */
    readonly unsupported: boolean,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

let loading: Promise<ArrayBuffer> | undefined;

const TOO_OLD =
  "This browser is too old for DNG Squeeze. Update to iOS 16.4 or later, or use a current Safari, Chrome, Edge or Firefox.";

/** A tiny module using a SIMD instruction (i8x16.popcnt), which libjxl's build relies on. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/** Why this browser can't run the compressor, or null if it can. Instant: no download. */
export function unsupportedReason(): string | null {
  if (typeof WebAssembly !== "object" || typeof Worker !== "function") return TOO_OLD;
  try {
    return WebAssembly.validate(SIMD_PROBE) ? null : TOO_OLD;
  } catch {
    return TOO_OLD;
  }
}

async function load(): Promise<ArrayBuffer> {
  const unsupported = unsupportedReason();
  if (unsupported) throw new EngineError(unsupported, true);
  let bytes: ArrayBuffer;
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError(`Couldn't load the compressor (${reason}). Check your connection and try again.`, false);
  }
  const magic = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (magic.length < 4 || magic[0] !== 0 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
    throw new EngineError("Couldn't load the compressor (unexpected response). Reload the page and try again.", false);
  }
  if (!WebAssembly.validate(bytes)) throw new EngineError(TOO_OLD, true);
  return bytes;
}

/** Resolves to the .wasm bytes; a failed download can be retried by calling again. */
export function loadEngine(): Promise<ArrayBuffer> {
  loading ??= load().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
