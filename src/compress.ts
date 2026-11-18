/** Reads, plans and compresses one DNG with the tile worker pool. */

import { analyzeDng, assembleDng, type DngPlan } from "./lib/dng.ts";
import { outputName } from "./lib/format.ts";
import { NeedMoreData } from "./lib/tiff.ts";
import type { TilePool } from "./worker/pool.ts";

/** Enough for the TIFF directories of every ProRAW file seen so far. */
const FIRST_READ = 1 << 20;

/** Reads as much of the start of the file as needed to plan the rewrite. */
export async function planFile(file: Blob): Promise<DngPlan> {
  let size = Math.min(file.size, FIRST_READ);
  for (;;) {
    const bytes = new Uint8Array(await file.slice(0, size).arrayBuffer());
    try {
      return analyzeDng(bytes, file.size);
    } catch (error) {
      if (!(error instanceof NeedMoreData) || size >= file.size) throw error;
      size = Math.min(file.size, Math.max(error.end, size * 2));
    }
  }
}

export interface CompressOptions {
  readonly effort: number;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
}

/**
 * Re-encodes every raw tile as verified lossless JPEG XL and returns the new
 * DNG. The result references the original file for all unchanged bytes.
 */
export async function compressDng(file: File, plan: DngPlan, pool: TilePool, options: CompressOptions): Promise<File> {
  const { image } = plan;
  const total = image.tiles.length;
  const results = new Array<Uint8Array<ArrayBuffer>>(total);

  // One failing tile stops the rest; so does the caller's signal.
  const controller = new AbortController();
  const outer = options.signal;
  const forward = (): void => controller.abort(outer?.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener("abort", forward, { once: true });
  const { signal } = controller;

  let next = 0;
  let done = 0;
  const lane = async (): Promise<void> => {
    while (next < total) {
      signal.throwIfAborted();
      const index = next++;
      const tile = image.tiles[index] as (typeof image.tiles)[number];
      const data = await file.slice(tile.offset, tile.offset + tile.length).arrayBuffer();
      signal.throwIfAborted();
      const result = await pool.run(
        {
          data,
          tileWidth: image.tileWidth,
          tileLength: image.tileLength,
          samplesPerPixel: image.samplesPerPixel,
          bytesPerSample: image.bytesPerSample,
          effort: options.effort,
        },
        signal,
      );
      results[index] = result.jxl;
      options.onProgress?.(++done, total);
    }
  };

  try {
    // Twice as many lanes as workers, so reading the next tile overlaps encoding.
    const lanes = Math.max(1, Math.min(total, pool.size * 2));
    await Promise.all(
      Array.from({ length: lanes }, () =>
        lane().catch((error: unknown) => {
          controller.abort(error);
          throw error;
        }),
      ),
    );
  } finally {
    outer?.removeEventListener("abort", forward);
  }

  const parts = assembleDng(plan, results, options.effort).map((segment) =>
    segment instanceof Uint8Array ? segment : file.slice(segment.start, segment.end),
  );
  return new File(parts, outputName(file.name), { type: "image/x-adobe-dng", lastModified: file.lastModified });
}
