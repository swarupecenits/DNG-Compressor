import { describe, expect, it } from "vitest";
import {
  COMPRESSION_JXL,
  COMPRESSION_LJ92,
  DngError,
  analyzeDng,
  assembleDng,
  concatSegments,
  segmentsLength,
  type DngPlan,
} from "../src/lib/dng.ts";
import { FieldType, NeedMoreData, Tag, TiffReader, findEntry, type Ifd } from "../src/lib/tiff.ts";
import { ascii, buildTiff, byte, long, offsetOf, rational, short, type Field, type IfdSpec } from "./tiff-builder.ts";

const PHOTOMETRIC_CFA = 32803;
const PHOTOMETRIC_LINEAR_RAW = 34892;

const filler = (length: number, seed: number): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 97) & 0xff);

/** Bytes that start and end like a JPEG. */
function jpeg(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = filler(length, seed);
  bytes.set([0xff, 0xd8, 0xff]);
  bytes.set([0xff, 0xd9], length - 2);
  return bytes;
}

const previewFields = (width: number, height: number): Field[] => [
  long(Tag.NewSubfileType, 1),
  long(Tag.ImageWidth, width),
  long(Tag.ImageLength, height),
  short(Tag.BitsPerSample, 8, 8, 8),
  short(Tag.Compression, COMPRESSION_LJ92),
  short(Tag.PhotometricInterpretation, 6),
  short(Tag.SamplesPerPixel, 3),
];

/** Replaces fields with the same tag, and drops `omit` tags. */
function withFields(base: readonly Field[], changes: readonly Field[] = [], omit: readonly number[] = []): Field[] {
  const replaced = new Set([...changes.map((field) => field.tag), ...omit]);
  return [...base.filter((field) => !replaced.has(field.tag)), ...changes];
}

interface Changes {
  readonly ifd0?: readonly Field[];
  readonly main?: readonly Field[];
  readonly omit?: readonly number[];
  /** Stores the raw image in strips instead of tiles. */
  readonly strips?: boolean;
}

/**
 * Laid out like Apple ProRAW: a preview in IFD0, and a 40x20 RGB raw image in
 * 2x2 tiles of 32x16 between two more previews in the SubIFDs.
 */
function proRaw(changes: Changes = {}) {
  const tiles = [filler(301, 1), filler(256, 2), filler(177, 3), filler(90, 4)];
  const main: IfdSpec = {
    fields: withFields(
      [
        long(Tag.NewSubfileType, 0),
        long(Tag.ImageWidth, 40),
        long(Tag.ImageLength, 20),
        short(Tag.BitsPerSample, 16, 16, 16),
        short(Tag.Compression, COMPRESSION_LJ92),
        short(Tag.PhotometricInterpretation, PHOTOMETRIC_LINEAR_RAW),
        short(Tag.SamplesPerPixel, 3),
        short(Tag.PlanarConfiguration, 1),
        short(Tag.TileWidth, 32),
        short(Tag.TileLength, 16),
        short(Tag.SampleFormat, 1, 1, 1),
      ],
      changes.main,
      changes.omit,
    ),
    ...(changes.strips ? { strips: tiles } : { tiles }),
  };
  // An odd size, so the raw data starts at an odd offset.
  const preview = jpeg(501, 7);
  const root: IfdSpec = {
    fields: withFields(
      [
        ...previewFields(400, 300),
        ascii(Tag.Make, "Apple"),
        ascii(Tag.Model, "iPhone 12 Pro"),
        short(Tag.Orientation, 6),
        byte(Tag.DNGVersion, 1, 6, 0, 0),
        byte(Tag.DNGBackwardVersion, 1, 3, 0, 0),
        ascii(Tag.UniqueCameraModel, "iPhone 12 Pro"),
      ],
      changes.ifd0,
      changes.omit,
    ),
    strips: [preview],
    subIfds: [
      { fields: previewFields(160, 120), strips: [jpeg(120, 5)] },
      main,
      { fields: previewFields(1024, 768), strips: [jpeg(900, 6)] },
    ],
    exif: { fields: [rational(33434, 1, 120), short(34855, 32), ascii(42036, "iPhone 12 Pro back camera")] },
  };
  return { root, main, tiles, preview };
}

function entry(ifd: Ifd, tag: number) {
  const found = findEntry(ifd, tag);
  if (!found) throw new Error(`Missing tag ${tag}`);
  return found;
}

/** Error code of analyzing a file, or "ok". */
function analysisResult(bytes: Uint8Array): string {
  try {
    analyzeDng(bytes, bytes.length);
    return "ok";
  } catch (error) {
    if (error instanceof DngError) return error.code;
    throw error;
  }
}

/** Offsets before the raw data that the rewrite is allowed to change. */
function patchedBytes(plan: DngPlan): Set<number> {
  const patched = new Set<number>();
  for (let i = 0; i < 4; i++) patched.add(plan.pointer + i);
  for (const patch of plan.versionPatches) patch.bytes.forEach((_, i) => patched.add(patch.offset + i));
  return patched;
}

function changedBytes(before: Uint8Array, after: Uint8Array, end: number, allowed: Set<number>): number[] {
  const changed: number[] = [];
  for (let i = 0; i < end; i++) if (before[i] !== after[i] && !allowed.has(i)) changed.push(i);
  return changed;
}

describe.each([
  ["big-endian", false],
  ["little-endian", true],
] as const)("%s ProRAW-style DNG", (_, littleEndian) => {
  const sample = proRaw();
  const built = buildTiff(sample.root, { littleEndian });
  const { bytes } = built;
  const plan = analyzeDng(bytes, bytes.length);

  it("finds the raw image, the preview and the metadata", () => {
    expect(plan).toMatchObject({
      fileSize: bytes.length,
      littleEndian,
      camera: "Apple iPhone 12 Pro",
      dngVersion: "1.6.0.0",
      orientation: 6,
      mainIsFirstIfd: false,
      next: 0,
      image: { width: 40, height: 20, tileWidth: 32, tileLength: 16, samplesPerPixel: 3, bitsPerSample: 16, bytesPerSample: 2 },
      // The smallest preview that is at least 320 pixels wide.
      preview: { offset: offsetOf(built.dataOffsets, sample.preview), length: 501, width: 400, height: 300 },
      cut: offsetOf(built.dataOffsets, sample.tiles[0]),
    });
    expect(plan.image.tiles).toEqual(
      sample.tiles.map((tile) => ({ offset: offsetOf(built.dataOffsets, tile), length: tile.length })),
    );
    expect(new TiffReader(bytes, bytes.length).u32(plan.pointer)).toBe(offsetOf(built.ifdOffsets, sample.main));
    expect(plan.versionPatches).toHaveLength(2);
    expect(plan.cut % 2).toBe(1);
  });

  it("only needs the bytes before the raw data", () => {
    let length = 16;
    let partial: DngPlan | undefined;
    while (!partial) {
      try {
        partial = analyzeDng(bytes.subarray(0, length), bytes.length);
      } catch (error) {
        if (!(error instanceof NeedMoreData)) throw error;
        expect(error.end).toBeGreaterThan(length);
        length = error.end;
      }
    }
    expect(length).toBeLessThanOrEqual(plan.cut);
    expect(partial).toEqual(plan);
  });

  it("swaps in the JPEG XL tiles and keeps everything else", () => {
    const jxl = [filler(11, 21), filler(12, 22), filler(7, 23), filler(30, 24)];
    const segments = assembleDng(plan, jxl, 7);
    const output = concatSegments(bytes, segments);
    expect(segmentsLength(segments)).toBe(output.length);
    expect(changedBytes(bytes, output, plan.cut, patchedBytes(plan))).toEqual([]);

    const reader = new TiffReader(output, output.length);
    const ifd0 = reader.readIfd(reader.firstIfd);
    expect(reader.uints(entry(ifd0, Tag.DNGVersion))).toEqual([1, 7, 0, 0]);
    expect(reader.uints(entry(ifd0, Tag.DNGBackwardVersion))).toEqual([1, 7, 0, 0]);

    const mainOffset = reader.u32(plan.pointer);
    expect(mainOffset % 4).toBe(0);
    const main = reader.readIfd(mainOffset);
    expect(mainOffset + main.byteLength).toBe(output.length);
    const tags = main.entries.map((e) => e.tag);
    expect(tags).toEqual([...tags].sort((a, b) => a - b));
    expect(reader.uint(entry(main, Tag.Compression))).toBe(COMPRESSION_JXL);
    expect(reader.uint(entry(main, Tag.JXLEffort))).toBe(7);
    const distance = entry(main, Tag.JXLDistance);
    expect(distance.type).toBe(FieldType.FLOAT);
    expect(new DataView(output.buffer).getFloat32(distance.valueOffset, littleEndian)).toBe(0);
    expect(main.next).toBe(0);

    const offsets = reader.uints(entry(main, Tag.TileOffsets));
    expect(reader.uints(entry(main, Tag.TileByteCounts))).toEqual(jxl.map((tile) => tile.length));
    jxl.forEach((tile, i) => {
      const at = offsets[i] as number;
      expect(at % 2).toBe(0);
      expect(at).toBeGreaterThanOrEqual(plan.cut);
      expect(output.subarray(at, at + tile.length)).toEqual(tile);
    });

    // Every other tag of the raw image keeps its exact directory entry.
    const source = new TiffReader(bytes, bytes.length);
    const replaced = new Set<number>([Tag.Compression, Tag.TileOffsets, Tag.TileByteCounts]);
    for (const old of source.readIfd(offsetOf(built.ifdOffsets, sample.main)).entries) {
      if (!replaced.has(old.tag)) expect(reader.rawEntry(entry(main, old.tag))).toEqual(source.rawEntry(old));
    }

    expect(analysisResult(output)).toBe("already-jxl");
  });

  it("checks the tiles it is given", () => {
    expect(() => assembleDng(plan, [filler(5, 1)], 5)).toThrow(/Expected 4 tiles/);
    expect(() => assembleDng(plan, [filler(5, 1), new Uint8Array(0), filler(5, 2), filler(5, 3)], 5)).toThrow(/Empty/);
  });
});

describe("raw image in IFD0", () => {
  const tile = filler(333, 9);
  const preview: IfdSpec = { fields: previewFields(256, 192), strips: [jpeg(300, 8)] };
  const root: IfdSpec = {
    fields: [
      long(Tag.NewSubfileType, 0),
      long(Tag.ImageWidth, 30),
      long(Tag.ImageLength, 10),
      short(Tag.BitsPerSample, 12),
      short(Tag.Compression, COMPRESSION_LJ92),
      short(Tag.PhotometricInterpretation, PHOTOMETRIC_LINEAR_RAW),
      long(Tag.TileWidth, 32),
      long(Tag.TileLength, 16),
      ascii(Tag.Make, "Acme"),
      ascii(Tag.Model, "Acme RAW 1"),
      byte(Tag.DNGVersion, 1, 4, 0, 0),
      byte(Tag.DNGBackwardVersion, 1, 1, 0, 0),
    ],
    tiles: [tile],
    next: preview,
  };
  const built = buildTiff(root, { littleEndian: true });
  const { bytes } = built;

  it("rewrites IFD0 with new versions and keeps the IFD chain", () => {
    const plan = analyzeDng(bytes, bytes.length);
    expect(plan).toMatchObject({
      camera: "Acme RAW 1",
      dngVersion: "1.4.0.0",
      orientation: 1,
      mainIsFirstIfd: true,
      pointer: 4,
      versionPatches: [],
      next: offsetOf(built.ifdOffsets, preview),
      image: { samplesPerPixel: 1, bitsPerSample: 12, bytesPerSample: 2, tiles: [{ length: 333 }] },
      // Smaller than 320 pixels, but the only one.
      preview: { width: 256, height: 192, length: 300 },
    });

    const jxl = filler(45, 3);
    const output = concatSegments(bytes, assembleDng(plan, [jxl], 3));
    expect(changedBytes(bytes, output, plan.cut, new Set([4, 5, 6, 7]))).toEqual([]);

    const reader = new TiffReader(output, output.length);
    expect(reader.firstIfd).toBeGreaterThan(plan.cut);
    const ifd0 = reader.readIfd(reader.firstIfd);
    expect(reader.uints(entry(ifd0, Tag.DNGVersion))).toEqual([1, 7, 0, 0]);
    expect(reader.uints(entry(ifd0, Tag.DNGBackwardVersion))).toEqual([1, 7, 0, 0]);
    expect(entry(ifd0, Tag.TileOffsets).inline).toBe(true);
    const at = reader.uint(entry(ifd0, Tag.TileOffsets));
    expect(output.subarray(at, at + jxl.length)).toEqual(jxl);
    expect(reader.uints(entry(ifd0, Tag.TileByteCounts))).toEqual([jxl.length]);
    expect(ifd0.next).toBe(offsetOf(built.ifdOffsets, preview));
    expect(reader.readIfd(ifd0.next).entries).toHaveLength(9);
    expect(analysisResult(output)).toBe("already-jxl");
  });
});

describe("analyzeDng rejects", () => {
  const build = (changes: Changes = {}, options: { tileGap?: number; trailing?: number; stripsLast?: boolean } = {}) =>
    buildTiff(proRaw(changes).root, { littleEndian: false, ...options }).bytes;

  it("other kinds of files", () => {
    expect(analysisResult(jpeg(64, 1))).toBe("jpeg");
    const heic = new Uint8Array(64);
    heic.set([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic")]);
    expect(analysisResult(heic)).toBe("heic");
    expect(analysisResult(new TextEncoder().encode("definitely not a raw photo"))).toBe("not-dng");
    expect(analysisResult(build({ omit: [Tag.DNGVersion] }))).toBe("not-dng");
  });

  it.each([
    ["Bayer raws", { main: [short(Tag.PhotometricInterpretation, PHOTOMETRIC_CFA)] }, "cfa"],
    ["JPEG XL raws", { main: [short(Tag.Compression, COMPRESSION_JXL)] }, "already-jxl"],
    ["uncompressed raws", { main: [short(Tag.Compression, 1)] }, "unsupported"],
    ["raws in strips", { strips: true }, "unsupported"],
    ["planar raws", { main: [short(Tag.PlanarConfiguration, 2)] }, "unsupported"],
    ["floating-point raws", { main: [short(Tag.SampleFormat, 3, 3, 3)] }, "unsupported"],
    ["32-bit raws", { main: [short(Tag.BitsPerSample, 32, 32, 32)] }, "unsupported"],
    ["4-channel raws", { main: [short(Tag.SamplesPerPixel, 4), short(Tag.BitsPerSample, 16, 16, 16, 16)] }, "unsupported"],
    ["files without a raw image", { main: [short(Tag.PhotometricInterpretation, 2)] }, "unsupported"],
    ["tile counts that don't fit the image", { main: [long(Tag.ImageWidth, 100)] }, "corrupt"],
  ] satisfies [string, Changes, string][])("%s", (_, changes, code) => {
    expect(analysisResult(build(changes))).toBe(code);
  });

  it("data stored after the raw image, but not padding", () => {
    expect(analysisResult(build({}, { tileGap: 3, trailing: 16 }))).toBe("ok");
    expect(analysisResult(build({}, { tileGap: 17 }))).toBe("unsupported");
    expect(analysisResult(build({}, { trailing: 17 }))).toBe("unsupported");
    expect(analysisResult(build({}, { stripsLast: true }))).toBe("unsupported");
  });

  it("damaged files", () => {
    const bytes = build();
    const looped = bytes.slice();
    const view = new DataView(looped.buffer);
    const ifd0 = view.getUint32(4);
    view.setUint32(ifd0 + 2 + 12 * view.getUint16(ifd0), ifd0);
    expect(analysisResult(looped)).toBe("corrupt");

    const outside = bytes.slice();
    new DataView(outside.buffer).setUint32(4, outside.length + 2);
    expect(analysisResult(outside)).toBe("corrupt");

    expect(analysisResult(bytes.subarray(0, 300))).toBe("corrupt");
  });
});
