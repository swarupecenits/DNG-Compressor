/** A pool of tile workers: started on demand, replaced if they crash, stopped when idle. */

import type { InitMessage, TileJob, WorkerResponse } from "./protocol.ts";

export interface TileTask {
  /** Lossless JPEG tile data; transferred (detached) when the job starts. */
  readonly data: ArrayBuffer;
  readonly tileWidth: number;
  readonly tileLength: number;
  readonly samplesPerPixel: number;
  readonly bytesPerSample: 1 | 2;
  readonly effort: number;
}

export interface TileResult {
  readonly jxl: Uint8Array<ArrayBuffer>;
  readonly decodeMs: number;
  readonly encodeMs: number;
}

interface Job {
  readonly id: number;
  readonly task: TileTask;
  readonly resolve: (result: TileResult) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

interface Slot {
  readonly worker: Worker;
  job: Job | null;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Idle workers are stopped after this long to give their memory back. */
const IDLE_TIMEOUT_MS = 20_000;

/** Phones get a few workers (memory, heat); computers leave one core for the page. */
export function defaultPoolSize(): number {
  const cores = navigator.hardwareConcurrency || 4;
  if (matchMedia("(pointer: coarse)").matches) return Math.max(1, Math.min(4, cores));
  return Math.max(2, Math.min(8, cores - 1));
}

export class TilePool {
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private nextId = 1;

  constructor(
    private readonly wasm: ArrayBuffer,
    readonly size = defaultPoolSize(),
  ) {}

  /** Compresses one tile. Aborting rejects at once; a running tile's result is then dropped. */
  run(task: TileTask, signal?: AbortSignal): Promise<TileResult> {
    return new Promise<TileResult>((resolve, reject) => {
      signal?.throwIfAborted();
      const job: Job = {
        id: this.nextId++,
        task,
        resolve: (result) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        reject: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
        settled: false,
      };
      const onAbort = (): void => {
        const queued = this.queue.indexOf(job);
        if (queued >= 0) this.queue.splice(queued, 1);
        this.settle(job, () => job.reject(signal?.reason));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private settle(job: Job, action: () => void): void {
    if (job.settled) return;
    job.settled = true;
    action();
  }

  private pump(): void {
    for (;;) {
      const job = this.queue[0];
      if (!job) return;
      if (job.settled) {
        this.queue.shift();
        continue;
      }
      let slot: Slot | undefined;
      for (const candidate of this.slots) {
        if (!candidate.job) {
          slot = candidate;
          break;
        }
      }
      if (!slot) {
        if (this.slots.size >= this.size) return;
        slot = this.spawn();
      }
      this.queue.shift();
      this.assign(slot, job);
    }
  }

  private assign(slot: Slot, job: Job): void {
    clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    const { task } = job;
    const message: TileJob = {
      type: "tile",
      id: job.id,
      data: task.data,
      tileWidth: task.tileWidth,
      tileLength: task.tileLength,
      samplesPerPixel: task.samplesPerPixel,
      bytesPerSample: task.bytesPerSample,
      effort: task.effort,
    };
    try {
      slot.worker.postMessage(message, [task.data]);
      slot.job = job;
    } catch (error) {
      this.settle(job, () => job.reject(error));
      this.idle(slot);
    }
  }

  private spawn(): Slot {
    const worker = new Worker(new URL("./tile.worker.ts", import.meta.url), {
      type: "module",
      name: "dng-squeeze-tile",
    });
    const slot: Slot = { worker, job: null, idleTimer: undefined };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(slot, event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.crash(slot, event.message || "The compressor stopped unexpectedly.");
    };
    worker.onmessageerror = () => this.crash(slot, "The compressor sent back unreadable data.");
    const init: InitMessage = { type: "init", wasm: this.wasm };
    worker.postMessage(init);
    this.slots.add(slot);
    return slot;
  }

  private receive(slot: Slot, message: WorkerResponse): void {
    const job = slot.job;
    if (!job || message.id !== job.id) return;
    slot.job = null;
    if (message.type === "tile") {
      const { jxl, decodeMs, encodeMs } = message;
      this.settle(job, () => job.resolve({ jxl, decodeMs, encodeMs }));
    } else {
      this.settle(job, () => job.reject(new Error(message.message)));
      if (message.fatal) {
        this.discard(slot);
        this.pump();
        return;
      }
    }
    this.pump();
    if (!slot.job) this.idle(slot);
  }

  /** A worker died: fail its tile and let a fresh worker take over the queue. */
  private crash(slot: Slot, reason: string): void {
    if (!this.slots.has(slot)) return;
    const job = slot.job;
    this.discard(slot);
    if (job) this.settle(job, () => job.reject(new Error(reason)));
    this.pump();
  }

  private idle(slot: Slot): void {
    clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
      if (!slot.job) this.discard(slot);
    }, IDLE_TIMEOUT_MS);
  }

  private discard(slot: Slot): void {
    clearTimeout(slot.idleTimer);
    slot.worker.terminate();
    slot.job = null;
    this.slots.delete(slot);
  }
}
