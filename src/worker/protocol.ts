/** Messages exchanged between the page and the tile workers. */

export interface InitMessage {
  readonly type: "init";
  /** The libjxl .wasm bytes; every worker compiles its own copy. */
  readonly wasm: ArrayBuffer;
}

export interface TileJob {
  readonly type: "tile";
  readonly id: number;
  /** Lossless JPEG (LJ92) tile data; transferred to the worker. */
  readonly data: ArrayBuffer;
  readonly tileWidth: number;
  readonly tileLength: number;
  readonly samplesPerPixel: number;
  readonly bytesPerSample: 1 | 2;
  readonly effort: number;
}

export type WorkerRequest = InitMessage | TileJob;

export interface TileDone {
  readonly type: "tile";
  readonly id: number;
  /** Verified lossless JPEG XL tile. */
  readonly jxl: Uint8Array<ArrayBuffer>;
  readonly decodeMs: number;
  readonly encodeMs: number;
}

export interface TileFailed {
  readonly type: "error";
  readonly id: number;
  readonly message: string;
  /** The worker is unusable afterwards and should be replaced. */
  readonly fatal: boolean;
}

export type WorkerResponse = TileDone | TileFailed;
