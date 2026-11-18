/** Turns one lossless-JPEG DNG tile into the samples its JPEG XL tile must hold. */

import { decodeLj92 } from "./lj92.ts";

export interface TileInput {
  readonly data: ArrayBuffer | Uint8Array;
  readonly tileWidth: number;
  readonly tileLength: number;
  readonly samplesPerPixel: number;
  readonly bytesPerSample: 1 | 2;
}

export function decodeTile(input: TileInput): Uint8Array | Uint16Array {
  const { data, tileWidth, tileLength, samplesPerPixel, bytesPerSample } = input;
  const { frame, samples, unusedBits } = decodeLj92(data instanceof Uint8Array ? data : new Uint8Array(data));
  const expected = tileWidth * tileLength * samplesPerPixel;
  if (samples.length !== expected) {
    throw new Error(`A raw tile holds ${samples.length} samples instead of ${expected}.`);
  }

  // Cheap consistency checks that catch misread data before it is re-encoded:
  // conforming streams end within a byte and never exceed their precision.
  if (unusedBits > 7) throw new Error("A raw tile has unexpected trailing data.");
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] as number;
    if (value > max) max = value;
  }
  if (max >= 2 ** frame.precision) throw new Error("A raw tile holds samples beyond its bit depth.");

  if (bytesPerSample === 2) return samples;
  if (max > 0xff) throw new Error("An 8-bit raw tile holds samples above 255.");
  return Uint8Array.from(samples);
}
