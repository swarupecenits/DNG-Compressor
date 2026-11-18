/**
 * End-to-end check on a real DNG, enabled with environment variables:
 *   DNG_SAMPLE     path to a lossless-JPEG DNG (e.g. Apple ProRAW)
 *   DNG_REFERENCE  optional decoded main image (row-major interleaved uint16 LE)
 *   DNG_OUT        optional path for the compressed DNG
 *   DNG_EFFORT     optional libjxl effort (default 5)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPRESSION_JXL, analyzeDng, assembleDng, concatSegments } from "../src/lib/dng.ts";
import { JxlCodec } from "../src/lib/jxl.ts";
import { decodeLj92 } from "../src/lib/lj92.ts";
import { Tag, TiffReader, findEntry } from "../src/lib/tiff.ts";
import { decodeTile } from "../src/lib/tile.ts";

const samplePath = process.env.DNG_SAMPLE;
const referencePath = process.env.DNG_REFERENCE;
const outPath = process.env.DNG_OUT;
const effort = Number(process.env.DNG_EFFORT ?? 5);

describe.skipIf(!samplePath)("real DNG sample", () => {
  it("re-encodes every tile losslessly and keeps the rest of the file", async () => {
    const source = new Uint8Array(readFileSync(samplePath as string));
    const plan = analyzeDng(source, source.length);
    const { image } = plan;
    const wasm = readFileSync(new URL("../src/wasm/jxl_tile.wasm", import.meta.url));
    const codec = await JxlCodec.create(wasm);
    const reference = referencePath ? new Uint8Array(readFileSync(referencePath)) : undefined;
    const across = Math.ceil(image.width / image.tileWidth);
    const spp = image.samplesPerPixel;

    let unusedBits = 0;
    let decodeMs = 0;
    let encodeMs = 0;
    const tiles = image.tiles.map((tile, index) => {
      const data = source.subarray(tile.offset, tile.offset + tile.length);
      unusedBits = Math.max(unusedBits, decodeLj92(data).unusedBits);
      const started = performance.now();
      const samples = decodeTile({ ...image, data });
      decodeMs += performance.now() - started;
      if (reference) {
        const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
        const x0 = (index % across) * image.tileWidth;
        const y0 = Math.floor(index / across) * image.tileLength;
        const rowBytes = Math.min(image.tileWidth, image.width - x0) * spp * 2;
        for (let row = 0; row < image.tileLength && y0 + row < image.height; row++) {
          const got = bytes.subarray(row * image.tileWidth * spp * 2, row * image.tileWidth * spp * 2 + rowBytes);
          const at = ((y0 + row) * image.width + x0) * spp * 2;
          expect(Buffer.compare(got, reference.subarray(at, at + rowBytes)), `tile ${index} row ${row}`).toBe(0);
        }
      }
      const encodeStart = performance.now();
      const jxl = codec.encodeLossless(samples, image.tileWidth, image.tileLength, spp, effort);
      encodeMs += performance.now() - encodeStart;
      return jxl;
    });

    const output = concatSegments(source, assembleDng(plan, tiles, effort));
    console.info(
      `${plan.camera} (DNG ${plan.dngVersion}), ${image.width}x${image.height}x${spp} ${image.bitsPerSample}-bit, ` +
        `${image.tiles.length} tiles of ${image.tileWidth}x${image.tileLength}: ` +
        `${source.length} -> ${output.length} bytes (${((1 - output.length / source.length) * 100).toFixed(1)}% smaller), ` +
        `decode ${(decodeMs / 1000).toFixed(1)} s, encode ${(encodeMs / 1000).toFixed(1)} s at effort ${effort}, ` +
        `max unused bits ${unusedBits}, libjxl ${codec.version}`,
    );
    expect(output.length).toBeLessThan(source.length);

    // Everything before the raw data is kept apart from the documented patches.
    const reader = new TiffReader(output, output.length);
    const mainOffset = reader.u32(plan.pointer);
    const patched = new Set<number>();
    for (let i = 0; i < 4; i++) patched.add(plan.pointer + i);
    for (const patch of plan.versionPatches) patch.bytes.forEach((_, i) => patched.add(patch.offset + i));
    let changed = 0;
    for (let i = 0; i < plan.cut; i++) if (output[i] !== source[i] && !patched.has(i)) changed++;
    expect(changed).toBe(0);

    // The new main IFD points at the new tiles and says JPEG XL.
    const main = reader.readIfd(mainOffset);
    const entry = (tag: number) => {
      const found = findEntry(main, tag);
      if (!found) throw new Error(`missing tag ${tag}`);
      return found;
    };
    expect(reader.uint(entry(Tag.Compression))).toBe(COMPRESSION_JXL);
    expect(reader.uint(entry(Tag.JXLEffort))).toBe(effort);
    const offsets = reader.uints(entry(Tag.TileOffsets));
    const counts = reader.uints(entry(Tag.TileByteCounts));
    tiles.forEach((tile, i) => {
      const at = offsets[i] as number;
      expect(counts[i]).toBe(tile.length);
      expect(Buffer.compare(output.subarray(at, at + tile.length), tile)).toBe(0);
    });

    // DNG 1.7 is declared, and the result is recognised as already compressed.
    const version = findEntry(reader.readIfd(reader.firstIfd), Tag.DNGVersion);
    const [major = 0, minor = 0] = version ? reader.uints(version) : [];
    expect(major * 100 + minor).toBeGreaterThanOrEqual(107);
    expect(() => analyzeDng(output, output.length)).toThrow(/already JPEG XL/);

    if (outPath) writeFileSync(outPath, output);
  });
});
