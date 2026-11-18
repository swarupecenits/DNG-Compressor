/** Minimal classic-TIFF reader/writer helpers (DNG is classic TIFF). */

export const Tag = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  Make: 271,
  Model: 272,
  StripOffsets: 273,
  Orientation: 274,
  SamplesPerPixel: 277,
  StripByteCounts: 279,
  PlanarConfiguration: 284,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SubIFDs: 330,
  SampleFormat: 339,
  JPEGTables: 347,
  JPEGInterchangeFormat: 513,
  JPEGInterchangeFormatLength: 514,
  ExifIFD: 34665,
  GPSIFD: 34853,
  InteroperabilityIFD: 40965,
  DNGVersion: 50706,
  DNGBackwardVersion: 50707,
  UniqueCameraModel: 50708,
  JXLDistance: 52553,
  JXLEffort: 52554,
  JXLDecodeSpeed: 52555,
} as const;

export const FieldType = {
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
  SBYTE: 6,
  UNDEFINED: 7,
  SSHORT: 8,
  SLONG: 9,
  SRATIONAL: 10,
  FLOAT: 11,
  DOUBLE: 12,
  IFD: 13,
} as const;

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4] as const;

/** Thrown when the parser needs bytes beyond the loaded prefix of the file. */
export class NeedMoreData extends Error {
  constructor(readonly end: number) {
    super(`Need the first ${end} bytes of the file`);
    this.name = "NeedMoreData";
  }
}

/** Thrown for structurally invalid TIFF data. */
export class TiffFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TiffFormatError";
  }
}

export interface IfdEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** File offset of the 12-byte directory entry. */
  readonly entryOffset: number;
  /** File offset of the value (inside the entry when `inline`). */
  readonly valueOffset: number;
  readonly byteLength: number;
  readonly inline: boolean;
}

export interface Ifd {
  readonly offset: number;
  readonly entries: readonly IfdEntry[];
  /** File offset of the 4-byte "next IFD" pointer. */
  readonly nextPointer: number;
  readonly next: number;
  /** Size of the directory structure itself (count + entries + next pointer). */
  readonly byteLength: number;
}

export function findEntry(ifd: Ifd, tag: number): IfdEntry | undefined {
  return ifd.entries.find((entry) => entry.tag === tag);
}

export class TiffReader {
  readonly littleEndian: boolean;
  readonly firstIfd: number;
  private readonly view: DataView;

  /**
   * @param bytes A prefix of the file (may be the whole file).
   * @param fileSize Size of the complete file.
   */
  constructor(
    readonly bytes: Uint8Array,
    readonly fileSize: number,
  ) {
    if (fileSize < 8) throw new TiffFormatError("File is too small to be a TIFF");
    if (bytes.length < 8) throw new NeedMoreData(8);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] === 0x49 && bytes[1] === 0x49) this.littleEndian = true;
    else if (bytes[0] === 0x4d && bytes[1] === 0x4d) this.littleEndian = false;
    else throw new TiffFormatError("Missing TIFF byte-order mark");
    const magic = this.u16(2);
    if (magic === 43) throw new TiffFormatError("BigTIFF files are not supported");
    if (magic !== 42) throw new TiffFormatError("Missing TIFF signature");
    this.firstIfd = this.u32(4);
  }

  check(offset: number, length: number): void {
    if (offset < 0 || length < 0 || offset + length > this.fileSize) {
      throw new TiffFormatError(`Data at offset ${offset} lies outside the file`);
    }
    if (offset + length > this.bytes.length) throw new NeedMoreData(offset + length);
  }

  u8(offset: number): number {
    this.check(offset, 1);
    return this.view.getUint8(offset);
  }

  u16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset, this.littleEndian);
  }

  u32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset, this.littleEndian);
  }

  readIfd(offset: number): Ifd {
    if (offset < 8) {
      throw new TiffFormatError(`Invalid IFD offset ${offset}`);
    }
    const count = this.u16(offset);
    if (count === 0 || count > 4096) {
      throw new TiffFormatError(`Implausible IFD entry count ${count}`);
    }
    const byteLength = 2 + count * 12 + 4;
    this.check(offset, byteLength);
    const entries: IfdEntry[] = [];
    for (let i = 0; i < count; i++) {
      const entryOffset = offset + 2 + i * 12;
      const tag = this.u16(entryOffset);
      const type = this.u16(entryOffset + 2);
      const valueCount = this.u32(entryOffset + 4);
      const size = TYPE_SIZE[type];
      if (size === undefined || size === 0) {
        throw new TiffFormatError(`Unknown TIFF field type ${type} for tag ${tag}`);
      }
      const length = size * valueCount;
      if (length > this.fileSize) {
        throw new TiffFormatError(`Tag ${tag} claims ${length} bytes`);
      }
      const inline = length <= 4;
      const valueOffset = inline ? entryOffset + 8 : this.u32(entryOffset + 8);
      if (!inline && valueOffset + length > this.fileSize) {
        throw new TiffFormatError(`Tag ${tag} points outside the file`);
      }
      entries.push({ tag, type, count: valueCount, entryOffset, valueOffset, byteLength: length, inline });
    }
    const nextPointer = offset + 2 + count * 12;
    return { offset, entries, nextPointer, next: this.u32(nextPointer), byteLength };
  }

  /** Reads unsigned integer values (BYTE, SHORT, LONG or IFD). */
  uints(entry: IfdEntry): number[] {
    const { type, count, valueOffset } = entry;
    let size: number;
    if (type === FieldType.BYTE || type === FieldType.UNDEFINED) size = 1;
    else if (type === FieldType.SHORT) size = 2;
    else if (type === FieldType.LONG || type === FieldType.IFD) size = 4;
    else throw new TiffFormatError(`Tag ${entry.tag} is not an unsigned integer`);
    this.check(valueOffset, size * count);
    const values = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      const at = valueOffset + i * size;
      values[i] = size === 1 ? this.u8(at) : size === 2 ? this.u16(at) : this.u32(at);
    }
    return values;
  }

  uint(entry: IfdEntry): number {
    if (entry.count < 1) throw new TiffFormatError(`Tag ${entry.tag} has no value`);
    return this.uints({ ...entry, count: 1 })[0] as number;
  }

  ascii(entry: IfdEntry): string {
    this.check(entry.valueOffset, entry.byteLength);
    let text = "";
    for (let i = 0; i < entry.byteLength; i++) {
      const code = this.bytes[entry.valueOffset + i] as number;
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text.trim();
  }

  /** Copies the raw 12-byte directory entry. */
  rawEntry(entry: IfdEntry): Uint8Array<ArrayBuffer> {
    this.check(entry.entryOffset, 12);
    return this.bytes.slice(entry.entryOffset, entry.entryOffset + 12);
  }
}

/** Endian-aware writer for freshly built structures. */
export class ByteWriter {
  readonly bytes: Uint8Array<ArrayBuffer>;
  private readonly view: DataView;

  constructor(
    length: number,
    private readonly littleEndian: boolean,
  ) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }

  u16(offset: number, value: number): void {
    this.view.setUint16(offset, value, this.littleEndian);
  }

  u32(offset: number, value: number): void {
    this.view.setUint32(offset, value, this.littleEndian);
  }

  f32(offset: number, value: number): void {
    this.view.setFloat32(offset, value, this.littleEndian);
  }
}
