/**
 * DNG analysis and rewriting: swaps the lossless-JPEG (LJ92) tiles of the main
 * raw image for lossless JPEG XL tiles, as allowed by DNG 1.7.
 *
 * The rewrite is deliberately conservative. Every byte before the main image
 * data is kept verbatim (previews, metadata, maker notes, gain maps), apart
 * from the DNG version bytes and the single pointer to the main IFD. The new
 * tiles and a new copy of the main IFD are appended after that.
 */

import {
  ByteWriter,
  FieldType,
  NeedMoreData,
  Tag,
  TiffFormatError,
  TiffReader,
  findEntry,
  type Ifd,
  type IfdEntry,
} from "./tiff.ts";

export const COMPRESSION_LJ92 = 7;
export const COMPRESSION_JXL = 52546;
const PHOTOMETRIC_CFA = 32803;
const PHOTOMETRIC_LINEAR_RAW = 34892;
const DNG_1_7: readonly number[] = [1, 7, 0, 0];
/** Largest gap tolerated between main-image tiles (alignment padding). */
const MAX_TILE_GAP = 16;
const MAX_IFDS = 512;
const MAX_TILES = 1 << 20;

export type DngErrorCode =
  | "not-dng"
  | "jpeg"
  | "heic"
  | "cfa"
  | "already-jxl"
  | "unsupported"
  | "corrupt";

export class DngError extends Error {
  constructor(
    readonly code: DngErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DngError";
  }
}

export interface TileRef {
  readonly offset: number;
  readonly length: number;
}

export interface RawImage {
  readonly width: number;
  readonly height: number;
  readonly tileWidth: number;
  readonly tileLength: number;
  readonly samplesPerPixel: 1 | 3;
  readonly bitsPerSample: number;
  readonly bytesPerSample: 1 | 2;
  readonly tiles: readonly TileRef[];
}

/** An embedded JPEG preview stored in one piece. */
export interface PreviewRef extends TileRef {
  readonly width: number;
  readonly height: number;
}

interface Patch {
  readonly offset: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

interface RawEntry {
  readonly tag: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface DngPlan {
  readonly fileSize: number;
  readonly littleEndian: boolean;
  /** Camera name for display, e.g. "Apple iPhone 15 Pro". */
  readonly camera: string;
  /** Original DNGVersion, e.g. "1.6.0.0". */
  readonly dngVersion: string;
  readonly image: RawImage;
  /** Smallest usable JPEG preview, for thumbnails. */
  readonly preview: PreviewRef | null;
  /** TIFF orientation of the photo (1–8). */
  readonly orientation: number;
  /** Start of the main image data; bytes before it are kept. */
  readonly cut: number;
  readonly mainIsFirstIfd: boolean;
  /** File offset of the pointer that references the main IFD. */
  readonly pointer: number;
  /** Raw 12-byte directory entries of the main IFD. */
  readonly entries: readonly RawEntry[];
  /** "Next IFD" pointer of the main IFD. */
  readonly next: number;
  readonly versionPatches: readonly Patch[];
}

/** Part of the output file: a byte range of the original file, or new bytes. */
export type Segment = { readonly start: number; readonly end: number } | Uint8Array<ArrayBuffer>;

interface WalkedIfd {
  readonly ifd: Ifd;
  /** File offset of the pointer that references this IFD. */
  readonly pointer: number;
  /** True for image IFDs (IFD chain and SubIFDs), false for Exif/GPS/Interop. */
  readonly image: boolean;
}

function sniff(bytes: Uint8Array): void {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    throw new DngError(
      "jpeg",
      "This is a JPEG, not a DNG. Picking from the photo library can convert photos — save the ProRAW originals to Files first.",
    );
  }
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    throw new DngError("heic", "This is a HEIC/HEIF photo, not a ProRAW DNG.");
  }
  const little = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42;
  if (!little && !big) throw new DngError("not-dng", "This file is not a DNG.");
}

function walk(reader: TiffReader): WalkedIfd[] {
  const result: WalkedIfd[] = [];
  const seen = new Set<number>();

  const visit = (offset: number, pointer: number, image: boolean, chain: boolean, depth: number): void => {
    let at = offset;
    let from = pointer;
    while (at !== 0) {
      if (seen.has(at)) throw new TiffFormatError("IFD loop");
      if (seen.size >= MAX_IFDS || depth > 8) throw new TiffFormatError("too many IFDs");
      seen.add(at);
      const ifd = reader.readIfd(at);
      result.push({ ifd, pointer: from, image });
      for (const entry of ifd.entries) {
        const pointerType = entry.type === FieldType.LONG || entry.type === FieldType.IFD;
        if (entry.tag === Tag.SubIFDs) {
          if (!pointerType) throw new TiffFormatError("invalid SubIFDs tag");
          reader.uints(entry).forEach((child, i) => {
            visit(child, entry.valueOffset + 4 * i, image, true, depth + 1);
          });
        } else if (
          entry.tag === Tag.ExifIFD ||
          entry.tag === Tag.GPSIFD ||
          entry.tag === Tag.InteroperabilityIFD
        ) {
          if (!pointerType || entry.count !== 1) throw new TiffFormatError(`invalid IFD pointer tag ${entry.tag}`);
          visit(reader.uint(entry), entry.valueOffset, false, false, depth + 1);
        }
      }
      if (!chain) break;
      from = ifd.nextPointer;
      at = ifd.next;
    }
  };

  visit(reader.firstIfd, 4, true, true, 0);
  return result;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 4; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Byte ranges of strip, tile or JPEG-interchange data referenced by an IFD. */
function dataRanges(reader: TiffReader, ifd: Ifd): TileRef[] {
  const ranges: TileRef[] = [];
  const pairs: [number, number][] = [
    [Tag.StripOffsets, Tag.StripByteCounts],
    [Tag.TileOffsets, Tag.TileByteCounts],
    [Tag.JPEGInterchangeFormat, Tag.JPEGInterchangeFormatLength],
  ];
  for (const [offsetTag, lengthTag] of pairs) {
    const offsetEntry = findEntry(ifd, offsetTag);
    const lengthEntry = findEntry(ifd, lengthTag);
    if (!offsetEntry && !lengthEntry) continue;
    if (!offsetEntry || !lengthEntry) throw new TiffFormatError(`incomplete tag pair ${offsetTag}/${lengthTag}`);
    const offsets = reader.uints(offsetEntry);
    const lengths = reader.uints(lengthEntry);
    if (offsets.length !== lengths.length) throw new TiffFormatError(`mismatched tag ${offsetTag}`);
    offsets.forEach((offset, i) => ranges.push({ offset, length: lengths[i] as number }));
  }
  return ranges;
}

function describeCamera(reader: TiffReader, ifd0: Ifd): string {
  const text = (tag: number): string => {
    const entry = findEntry(ifd0, tag);
    return entry && entry.type === FieldType.ASCII ? reader.ascii(entry) : "";
  };
  const make = text(Tag.Make);
  const model = text(Tag.Model);
  if (model) return make && !model.startsWith(make) ? `${make} ${model}` : model;
  return text(Tag.UniqueCameraModel) || "Unknown camera";
}

function unsupportedLayout(): DngError {
  return new DngError(
    "unsupported",
    "This DNG stores other data after the raw image, so it can't be rewritten safely.",
  );
}

/**
 * Picks the smallest JPEG preview that is still at least 320 pixels on its long
 * side (or the largest one), stored as a single strip or JPEG interchange block.
 */
function findPreview(reader: TiffReader, walked: readonly WalkedIfd[], main: Ifd): PreviewRef | null {
  const candidates: PreviewRef[] = [];
  for (const { ifd, image } of walked) {
    if (!image || ifd === main) continue;
    const get = (tag: number): number | undefined => {
      const entry = findEntry(ifd, tag);
      return entry && entry.count >= 1 ? reader.uint(entry) : undefined;
    };
    const width = get(Tag.ImageWidth);
    const height = get(Tag.ImageLength);
    const compression = get(Tag.Compression);
    const photometric = get(Tag.PhotometricInterpretation);
    if (!width || !height || ((get(Tag.NewSubfileType) ?? 0) & 1) === 0) continue;
    if (!(compression === COMPRESSION_LJ92 || compression === 6) || (photometric !== 6 && photometric !== 2)) continue;
    // Abbreviated JPEG strips need shared tables and can't be decoded on their own.
    if (findEntry(ifd, Tag.JPEGTables)) continue;
    const ranges = dataRanges(reader, ifd);
    const data = ranges.length === 1 ? ranges[0] : undefined;
    if (data && data.length > 0 && data.offset + data.length <= reader.fileSize) {
      candidates.push({ offset: data.offset, length: data.length, width, height });
    }
  }
  candidates.sort((a, b) => a.width * a.height - b.width * b.height);
  return candidates.find((c) => Math.max(c.width, c.height) >= 320) ?? candidates.at(-1) ?? null;
}

function analyze(reader: TiffReader): DngPlan {
  const walked = walk(reader);
  const first = walked[0];
  if (!first) throw new TiffFormatError("missing IFD0");
  const ifd0 = first.ifd;

  const versionEntry = findEntry(ifd0, Tag.DNGVersion);
  if (!versionEntry) throw new DngError("not-dng", "This TIFF file is not a DNG.");
  if (versionEntry.type !== FieldType.BYTE || versionEntry.count !== 4) {
    throw new TiffFormatError("invalid DNGVersion tag");
  }
  const version = reader.uints(versionEntry);

  const value = (ifd: Ifd, tag: number, fallback?: number): number => {
    const entry = findEntry(ifd, tag);
    if (entry) return reader.uint(entry);
    if (fallback === undefined) throw new DngError("unsupported", `The raw image is missing TIFF tag ${tag}.`);
    return fallback;
  };

  const main = walked.find(({ ifd, image }) => {
    if (!image || value(ifd, Tag.NewSubfileType, 0) !== 0) return false;
    const photometric = findEntry(ifd, Tag.PhotometricInterpretation);
    if (!photometric) return false;
    const kind = reader.uint(photometric);
    return kind === PHOTOMETRIC_CFA || kind === PHOTOMETRIC_LINEAR_RAW;
  });
  if (!main) throw new DngError("unsupported", "No raw image was found in this DNG.");
  const ifd = main.ifd;

  if (value(ifd, Tag.PhotometricInterpretation) === PHOTOMETRIC_CFA) {
    throw new DngError(
      "cfa",
      "This DNG holds an unprocessed Bayer mosaic. DNG only allows JPEG XL for demosaiced raws such as Apple ProRAW.",
    );
  }
  const compression = value(ifd, Tag.Compression, 1);
  if (compression === COMPRESSION_JXL) {
    throw new DngError("already-jxl", "This DNG is already JPEG XL compressed.");
  }
  if (compression !== COMPRESSION_LJ92) {
    throw new DngError("unsupported", `Unsupported raw compression (${compression}); only lossless JPEG DNGs are supported.`);
  }

  const width = value(ifd, Tag.ImageWidth);
  const height = value(ifd, Tag.ImageLength);
  const tileOffsetsEntry = findEntry(ifd, Tag.TileOffsets);
  const tileCountsEntry = findEntry(ifd, Tag.TileByteCounts);
  if (!tileOffsetsEntry || !tileCountsEntry || !findEntry(ifd, Tag.TileWidth)) {
    throw new DngError("unsupported", "Only tiled raw images are supported.");
  }
  const tileWidth = value(ifd, Tag.TileWidth);
  const tileLength = value(ifd, Tag.TileLength);
  const samplesPerPixel = value(ifd, Tag.SamplesPerPixel, 1);
  if (samplesPerPixel !== 1 && samplesPerPixel !== 3) {
    throw new DngError("unsupported", `Unsupported samples per pixel (${samplesPerPixel}).`);
  }
  if (samplesPerPixel > 1 && value(ifd, Tag.PlanarConfiguration, 1) !== 1) {
    throw new DngError("unsupported", "Planar raw images are not supported.");
  }
  const formatEntry = findEntry(ifd, Tag.SampleFormat);
  if (formatEntry && reader.uints(formatEntry).some((format) => format !== 1)) {
    throw new DngError("unsupported", "Only unsigned integer raw data is supported.");
  }
  const bitsEntry = findEntry(ifd, Tag.BitsPerSample);
  const bits = bitsEntry ? reader.uints(bitsEntry) : [1];
  const bitsPerSample = bits[0] as number;
  if (bits.some((b) => b !== bitsPerSample) || bitsPerSample < 8 || bitsPerSample > 16) {
    throw new DngError("unsupported", `Unsupported bit depth (${bits.join("/")}).`);
  }
  if (width < 1 || height < 1 || tileWidth < 1 || tileLength < 1) {
    throw new TiffFormatError("invalid raw image size");
  }

  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileLength);
  const offsets = reader.uints(tileOffsetsEntry);
  const counts = reader.uints(tileCountsEntry);
  if (tilesAcross * tilesDown > MAX_TILES || offsets.length !== tilesAcross * tilesDown || counts.length !== offsets.length) {
    throw new TiffFormatError("tile count does not match the image size");
  }
  const fileSize = reader.fileSize;
  const tiles = offsets.map((offset, i): TileRef => ({ offset, length: counts[i] as number }));
  let cut = fileSize;
  for (const tile of tiles) {
    if (tile.length === 0 || tile.offset + tile.length > fileSize) {
      throw new TiffFormatError("raw tile lies outside the file");
    }
    cut = Math.min(cut, tile.offset);
  }

  // Everything except the main tiles must live before `cut`...
  for (const { ifd: other } of walked) {
    const ranges: TileRef[] = [{ offset: other.offset, length: other.byteLength }];
    for (const entry of other.entries) {
      if (!entry.inline) ranges.push({ offset: entry.valueOffset, length: entry.byteLength });
    }
    if (other !== ifd) ranges.push(...dataRanges(reader, other));
    if (ranges.some((range) => range.offset + range.length > cut)) throw unsupportedLayout();
  }
  if (findEntry(ifd, Tag.JPEGInterchangeFormat)) throw unsupportedLayout();

  // ...and the main tiles must fill the rest of the file.
  const sorted = [...tiles].sort((a, b) => a.offset - b.offset || a.length - b.length);
  let end = cut;
  let previous: TileRef | undefined;
  for (const tile of sorted) {
    if (previous && tile.offset === previous.offset && tile.length === previous.length) continue;
    if (tile.offset < end) throw new TiffFormatError("overlapping raw tiles");
    if (tile.offset - end > MAX_TILE_GAP) throw unsupportedLayout();
    end = tile.offset + tile.length;
    previous = tile;
  }
  if (fileSize - end > MAX_TILE_GAP) throw unsupportedLayout();

  // DNG 1.7 readers are required for JPEG XL: raise both version tags.
  const versionPatches: Patch[] = [];
  const bump = (entry: IfdEntry | undefined): void => {
    if (!entry) return;
    if (entry.type !== FieldType.BYTE || entry.count !== 4) throw new TiffFormatError(`invalid tag ${entry.tag}`);
    if (compareVersions(reader.uints(entry), DNG_1_7) < 0) {
      versionPatches.push({ offset: entry.valueOffset, bytes: Uint8Array.from(DNG_1_7) });
    }
  };
  bump(versionEntry);
  bump(findEntry(ifd0, Tag.DNGBackwardVersion));

  const mainIsFirstIfd = ifd === ifd0;
  const entries = ifd.entries.map((entry): RawEntry => {
    const bytes = reader.rawEntry(entry);
    if (mainIsFirstIfd) {
      const patch = versionPatches.find((p) => p.offset === entry.valueOffset);
      if (patch) bytes.set(patch.bytes, 8);
    }
    return { tag: entry.tag, bytes };
  });

  // Previews and orientation are optional extras: never fail the rewrite because of them.
  let preview: PreviewRef | null = null;
  let orientation = 1;
  try {
    preview = findPreview(reader, walked, ifd);
    orientation = value(ifd0, Tag.Orientation, 1);
  } catch (error) {
    if (error instanceof NeedMoreData) throw error;
  }

  return {
    fileSize,
    littleEndian: reader.littleEndian,
    camera: describeCamera(reader, ifd0),
    dngVersion: version.join("."),
    image: {
      width,
      height,
      tileWidth,
      tileLength,
      samplesPerPixel,
      bitsPerSample,
      bytesPerSample: bitsPerSample <= 8 ? 1 : 2,
      tiles,
    },
    preview,
    orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
    cut,
    mainIsFirstIfd,
    pointer: main.pointer,
    entries,
    next: ifd.next,
    versionPatches: mainIsFirstIfd ? [] : versionPatches,
  };
}

/**
 * Plans the rewrite of a DNG.
 *
 * @param bytes A prefix of the file; throws {@link NeedMoreData} if it is too short.
 * @param fileSize Size of the whole file.
 */
export function analyzeDng(bytes: Uint8Array, fileSize: number): DngPlan {
  if (bytes.length < Math.min(fileSize, 16)) throw new NeedMoreData(Math.min(fileSize, 16));
  sniff(bytes);
  try {
    return analyze(new TiffReader(bytes, fileSize));
  } catch (error) {
    if (error instanceof TiffFormatError) {
      throw new DngError("corrupt", `This DNG looks damaged (${error.message}).`);
    }
    throw error;
  }
}

function makeEntry(
  littleEndian: boolean,
  tag: number,
  type: number,
  count: number,
  write: (w: ByteWriter) => void,
): RawEntry {
  const w = new ByteWriter(12, littleEndian);
  w.u16(0, tag);
  w.u16(2, type);
  w.u32(4, count);
  write(w);
  return { tag, bytes: w.bytes };
}

/**
 * Lays out the compressed DNG.
 *
 * @param tiles Lossless JPEG XL data for every main-image tile, in tile order.
 * @param effort libjxl effort used, recorded in the JXLEffort tag.
 */
export function assembleDng(plan: DngPlan, tiles: readonly Uint8Array<ArrayBuffer>[], effort: number): Segment[] {
  const count = plan.image.tiles.length;
  if (tiles.length !== count) throw new Error(`Expected ${count} tiles, got ${tiles.length}`);
  const le = plan.littleEndian;
  const segments: Segment[] = [];

  // New tile data, word aligned, after the preserved part of the file.
  let position = plan.cut;
  const offsets: number[] = [];
  const tail: Segment[] = [];
  for (const tile of tiles) {
    if (tile.length === 0) throw new Error("Empty JPEG XL tile");
    if (position % 2 !== 0) {
      tail.push(new Uint8Array(1));
      position++;
    }
    offsets.push(position);
    tail.push(tile);
    position += tile.length;
  }

  // Tile arrays (unless they fit inline) and the new main IFD.
  const padding = (4 - (position % 4)) % 4;
  const arrays = position + padding;
  const arrayBytes = count > 1 ? 8 * count : 0;
  const ifdOffset = arrays + arrayBytes;
  const newEntries = new Map<number, RawEntry>();
  for (const raw of plan.entries) {
    if (raw.tag !== Tag.JXLDistance && raw.tag !== Tag.JXLEffort && raw.tag !== Tag.JXLDecodeSpeed) {
      newEntries.set(raw.tag, raw);
    }
  }
  newEntries.set(
    Tag.Compression,
    makeEntry(le, Tag.Compression, FieldType.SHORT, 1, (w) => w.u16(8, COMPRESSION_JXL)),
  );
  newEntries.set(
    Tag.TileOffsets,
    makeEntry(le, Tag.TileOffsets, FieldType.LONG, count, (w) =>
      w.u32(8, count > 1 ? arrays : (offsets[0] as number)),
    ),
  );
  newEntries.set(
    Tag.TileByteCounts,
    makeEntry(le, Tag.TileByteCounts, FieldType.LONG, count, (w) =>
      w.u32(8, count > 1 ? arrays + 4 * count : (tiles[0] as Uint8Array).length),
    ),
  );
  newEntries.set(Tag.JXLDistance, makeEntry(le, Tag.JXLDistance, FieldType.FLOAT, 1, (w) => w.f32(8, 0)));
  newEntries.set(Tag.JXLEffort, makeEntry(le, Tag.JXLEffort, FieldType.LONG, 1, (w) => w.u32(8, effort)));
  const sortedEntries = [...newEntries.values()].sort((a, b) => a.tag - b.tag);

  const ifdBytes = 2 + 12 * sortedEntries.length + 4;
  const total = ifdOffset + ifdBytes;
  if (total > 0xffffffff) throw new DngError("unsupported", "The compressed file would exceed 4 GB.");

  const writer = new ByteWriter(padding + arrayBytes + ifdBytes, le);
  if (count > 1) {
    offsets.forEach((offset, i) => writer.u32(padding + 4 * i, offset));
    tiles.forEach((tile, i) => writer.u32(padding + 4 * count + 4 * i, tile.length));
  }
  let at = padding + arrayBytes;
  writer.u16(at, sortedEntries.length);
  at += 2;
  for (const raw of sortedEntries) {
    writer.bytes.set(raw.bytes, at);
    at += 12;
  }
  writer.u32(at, plan.next);
  tail.push(writer.bytes);

  // Preserved prefix with the version bumps and the re-pointed main IFD.
  const pointer = new ByteWriter(4, le);
  pointer.u32(0, ifdOffset);
  const patches: Patch[] = [...plan.versionPatches, { offset: plan.pointer, bytes: pointer.bytes }];
  patches.sort((a, b) => a.offset - b.offset);
  let from = 0;
  for (const patch of patches) {
    if (patch.offset < from || patch.offset + patch.bytes.length > plan.cut) {
      throw new Error("Invalid patch location");
    }
    if (patch.offset > from) segments.push({ start: from, end: patch.offset });
    segments.push(patch.bytes);
    from = patch.offset + patch.bytes.length;
  }
  if (from < plan.cut) segments.push({ start: from, end: plan.cut });
  segments.push(...tail);
  return segments;
}

/** Total byte length of a segment list. */
export function segmentsLength(segments: readonly Segment[]): number {
  let total = 0;
  for (const segment of segments) {
    total += segment instanceof Uint8Array ? segment.length : segment.end - segment.start;
  }
  return total;
}

/** Concatenates segments against an in-memory copy of the source file. */
export function concatSegments(source: Uint8Array, segments: readonly Segment[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(segmentsLength(segments));
  let at = 0;
  for (const segment of segments) {
    const bytes = segment instanceof Uint8Array ? segment : source.subarray(segment.start, segment.end);
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
