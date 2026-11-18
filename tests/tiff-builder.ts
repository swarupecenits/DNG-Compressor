/** Builds small classic-TIFF/DNG files for tests. */

import { FieldType, Tag } from "../src/lib/tiff.ts";

export interface Field {
  readonly tag: number;
  readonly type: number;
  /** Values; RATIONAL fields list numerators and denominators in turn. */
  readonly values: readonly number[];
}

export interface IfdSpec {
  readonly fields: readonly Field[];
  /** Child IFDs, referenced by a SubIFDs tag. */
  readonly subIfds?: readonly IfdSpec[];
  /** Referenced by an ExifIFD tag. */
  readonly exif?: IfdSpec;
  /** Data referenced by StripOffsets and StripByteCounts. */
  readonly strips?: readonly Uint8Array[];
  /** Data referenced by TileOffsets and TileByteCounts, stored at the end of the file. */
  readonly tiles?: readonly Uint8Array[];
  readonly next?: IfdSpec;
}

export interface BuildOptions {
  readonly littleEndian: boolean;
  /** Bytes left between consecutive tiles. */
  readonly tileGap?: number;
  /** Bytes appended after the last tile. */
  readonly trailing?: number;
  /** Stores strip data after the tiles instead of before them. */
  readonly stripsLast?: boolean;
}

export interface BuiltTiff {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly ifdOffsets: ReadonlyMap<IfdSpec, number>;
  /** File offset of every strip and tile. */
  readonly dataOffsets: ReadonlyMap<Uint8Array, number>;
}

export const byte = (tag: number, ...values: number[]): Field => ({ tag, type: FieldType.BYTE, values });
export const short = (tag: number, ...values: number[]): Field => ({ tag, type: FieldType.SHORT, values });
export const long = (tag: number, ...values: number[]): Field => ({ tag, type: FieldType.LONG, values });
export const rational = (tag: number, numerator: number, denominator: number): Field => ({
  tag,
  type: FieldType.RATIONAL,
  values: [numerator, denominator],
});
export const ascii = (tag: number, text: string): Field => ({
  tag,
  type: FieldType.ASCII,
  values: [...Array.from(text, (char) => char.charCodeAt(0)), 0],
});

/** Looks up an offset recorded while building. */
export function offsetOf<K>(offsets: ReadonlyMap<K, number>, key: K | undefined): number {
  const offset = key === undefined ? undefined : offsets.get(key);
  if (offset === undefined) throw new Error("Not part of the built file");
  return offset;
}

interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  readonly byteLength: number;
  /** Resolved once every offset is known. */
  readonly values: () => readonly number[];
  valueOffset: number;
}

function elementSize(type: number): number {
  if (type === FieldType.SHORT) return 2;
  if (type === FieldType.LONG || type === FieldType.RATIONAL) return 4;
  return 1;
}

function entriesOf(spec: IfdSpec, ifds: Map<IfdSpec, number>, data: Map<Uint8Array, number>): Entry[] {
  const entries: Entry[] = [];
  const add = (tag: number, type: number, length: number, values: () => readonly number[]): void => {
    const count = type === FieldType.RATIONAL ? length / 2 : length;
    entries.push({ tag, type, count, byteLength: length * elementSize(type), values, valueOffset: 0 });
  };
  const pointers = (offsetTag: number, countTag: number, items: readonly Uint8Array[]): void => {
    add(offsetTag, FieldType.LONG, items.length, () => items.map((item) => offsetOf(data, item)));
    add(countTag, FieldType.LONG, items.length, () => items.map((item) => item.length));
  };

  for (const field of spec.fields) add(field.tag, field.type, field.values.length, () => field.values);
  const { subIfds, exif, strips, tiles } = spec;
  if (subIfds) add(Tag.SubIFDs, FieldType.LONG, subIfds.length, () => subIfds.map((child) => offsetOf(ifds, child)));
  if (exif) add(Tag.ExifIFD, FieldType.LONG, 1, () => [offsetOf(ifds, exif)]);
  if (strips) pointers(Tag.StripOffsets, Tag.StripByteCounts, strips);
  if (tiles) pointers(Tag.TileOffsets, Tag.TileByteCounts, tiles);
  return entries.sort((a, b) => a.tag - b.tag);
}

/**
 * Lays out the IFD tree like a camera would: directories, their values and
 * strips first, then the tiles, which end the file.
 */
export function buildTiff(root: IfdSpec, options: BuildOptions): BuiltTiff {
  const ifdOffsets = new Map<IfdSpec, number>();
  const dataOffsets = new Map<Uint8Array, number>();
  const placed: { spec: IfdSpec; entries: Entry[] }[] = [];
  let size = 8;
  const alloc = (length: number): number => {
    size += size % 2;
    const at = size;
    size += length;
    return at;
  };

  const lay = (spec: IfdSpec): void => {
    const entries = entriesOf(spec, ifdOffsets, dataOffsets);
    ifdOffsets.set(spec, alloc(2 + 12 * entries.length + 4));
    for (const entry of entries) if (entry.byteLength > 4) entry.valueOffset = alloc(entry.byteLength);
    placed.push({ spec, entries });
    spec.subIfds?.forEach(lay);
    if (spec.exif) lay(spec.exif);
    if (!options.stripsLast) for (const strip of spec.strips ?? []) dataOffsets.set(strip, alloc(strip.length));
    if (spec.next) lay(spec.next);
  };
  lay(root);

  let firstTile = true;
  for (const { spec } of placed) {
    for (const tile of spec.tiles ?? []) {
      if (!firstTile) size += options.tileGap ?? 0;
      firstTile = false;
      dataOffsets.set(tile, size);
      size += tile.length;
    }
  }
  if (options.stripsLast) {
    for (const { spec } of placed) for (const strip of spec.strips ?? []) dataOffsets.set(strip, alloc(strip.length));
  }
  const trailing = options.trailing ?? 0;
  size += trailing;

  const le = options.littleEndian;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(le ? [0x49, 0x49, 42, 0] : [0x4d, 0x4d, 0, 42]);
  view.setUint32(4, offsetOf(ifdOffsets, root), le);
  for (const { spec, entries } of placed) {
    const offset = offsetOf(ifdOffsets, spec);
    view.setUint16(offset, entries.length, le);
    entries.forEach((entry, i) => {
      const at = offset + 2 + 12 * i;
      view.setUint16(at, entry.tag, le);
      view.setUint16(at + 2, entry.type, le);
      view.setUint32(at + 4, entry.count, le);
      const inline = entry.byteLength <= 4;
      if (!inline) view.setUint32(at + 8, entry.valueOffset, le);
      const width = elementSize(entry.type);
      let to = inline ? at + 8 : entry.valueOffset;
      for (const value of entry.values()) {
        if (width === 1) view.setUint8(to, value);
        else if (width === 2) view.setUint16(to, value, le);
        else view.setUint32(to, value, le);
        to += width;
      }
    });
    view.setUint32(offset + 2 + 12 * entries.length, spec.next ? offsetOf(ifdOffsets, spec.next) : 0, le);
  }
  for (const [data, offset] of dataOffsets) bytes.set(data, offset);
  bytes.fill(0xee, size - trailing);
  return { bytes, ifdOffsets, dataOffsets };
}
