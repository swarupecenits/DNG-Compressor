/** Tile worker: lossless JPEG tile -> verified lossless JPEG XL tile. */

import { JxlCodec } from "../lib/jxl.ts";
import { decodeTile } from "../lib/tile.ts";
import type { TileJob, WorkerRequest, WorkerResponse } from "./protocol.ts";

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let codec: Promise<JxlCodec> | undefined;

function handleTile(job: TileJob, jxl: JxlCodec): void {
  const started = performance.now();
  const samples = decodeTile(job);
  const decoded = performance.now();
  const bytes = jxl.encodeLossless(samples, job.tileWidth, job.tileLength, job.samplesPerPixel, job.effort);
  scope.postMessage(
    { type: "tile", id: job.id, jxl: bytes, decodeMs: decoded - started, encodeMs: performance.now() - decoded },
    [bytes.buffer],
  );
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "init") {
    codec = JxlCodec.create(message.wasm);
    return;
  }
  const ready = codec ?? Promise.reject(new Error("The compressor was not initialised."));
  ready.then(
    (jxl) => {
      try {
        handleTile(message, jxl);
      } catch (error) {
        scope.postMessage({
          type: "error",
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
          // A WebAssembly trap leaves the module in an undefined state.
          fatal: error instanceof WebAssembly.RuntimeError,
        });
      }
    },
    (error: unknown) => {
      scope.postMessage({
        type: "error",
        id: message.id,
        message: `Could not start the compressor: ${error instanceof Error ? error.message : String(error)}`,
        fatal: true,
      });
    },
  );
};
