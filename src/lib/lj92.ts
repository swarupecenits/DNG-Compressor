/**
 * Lossless JPEG (ITU-T T.81 process 14, "LJ92") decoder, as used by DNG.
 *
 * Returns the samples as a flat row-major, component-interleaved stream, which
 * is how DNG maps lossless JPEG data onto a tile (only the total sample count
 * has to match the tile).
 */

export class Lj92Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Lj92Error";
  }
}

export interface Lj92Frame {
  readonly width: number;
  readonly height: number;
  readonly components: number;
  readonly precision: number;
}

export interface Lj92Image {
  readonly frame: Lj92Frame;
  readonly samples: Uint16Array<ArrayBuffer>;
  /**
   * Most entropy-coded bits left unused before a marker. Encoders only pad to
   * a byte boundary, so anything above 7 suggests the data was misread.
   */
  readonly unusedBits: number;
}

interface FrameComponent {
  readonly id: number;
}

interface ScanComponent {
  readonly index: number;
  readonly table: Uint16Array;
}

const MARKER_SOI = 0xd8;
const MARKER_EOI = 0xd9;
const MARKER_SOF3 = 0xc3;
const MARKER_DHT = 0xc4;
const MARKER_SOS = 0xda;
const MARKER_DRI = 0xdd;
const MARKER_DNL = 0xdc;

/**
 * Builds a 16-bit lookahead table: entry = (code length << 8) | symbol, or 0
 * for bit patterns that are not a valid code.
 */
function buildHuffmanTable(counts: Uint8Array, symbols: Uint8Array): Uint16Array {
  const lookup = new Uint16Array(1 << 16);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1] as number;
    for (let i = 0; i < count; i++) {
      const symbol = symbols[k++] as number;
      if (symbol > 16) throw new Lj92Error(`Invalid lossless Huffman symbol ${symbol}`);
      const shift = 16 - length;
      const start = code << shift;
      const end = (code + 1) << shift;
      if (end > 1 << 16) throw new Lj92Error("Invalid Huffman table");
      lookup.fill((length << 8) | symbol, start, end);
      code++;
    }
    code <<= 1;
  }
  return lookup;
}

/** MSB-first bit reader over entropy-coded data with JPEG byte stuffing. */
class BitReader {
  /** Most data bits left unread at the end of a scan or restart interval. */
  maxUnusedBits = 0;
  private buffer = 0;
  private count = 0;
  /** Zero bits fed after the end of the entropy-coded segment. */
  private padding = 0;
  private atMarker = false;

  constructor(
    private readonly data: Uint8Array,
    public position: number,
  ) {}

  /** Data bits not consumed yet: buffered ones plus bytes before the next marker. */
  private unusedBits(): number {
    let bits = this.count - Math.min(this.padding, this.count);
    if (!this.atMarker) {
      const data = this.data;
      let at = this.position;
      while (at < data.length) {
        if (data[at] === 0xff) {
          if (data[at + 1] !== 0x00) break;
          at += 2;
        } else {
          at++;
        }
        bits += 8;
      }
    }
    return bits;
  }

  private fill(): void {
    const data = this.data;
    while (this.count <= 24) {
      let byte = 0;
      if (!this.atMarker) {
        if (this.position >= data.length) {
          this.atMarker = true;
        } else {
          byte = data[this.position] as number;
          if (byte === 0xff) {
            if (data[this.position + 1] === 0x00) {
              this.position += 2;
            } else {
              this.atMarker = true;
              byte = 0;
            }
          } else {
            this.position++;
          }
        }
      }
      if (this.atMarker) this.padding += 8;
      this.buffer = (this.buffer << 8) | byte;
      this.count += 8;
    }
  }

  /** Decodes one Huffman-coded difference (T.81 F.2.2.1 / H.1.2.2). */
  difference(table: Uint16Array): number {
    if (this.count < 16) this.fill();
    const entry = table[(this.buffer >>> (this.count - 16)) & 0xffff] as number;
    if (entry === 0) throw new Lj92Error("Invalid Huffman code");
    this.count -= entry >> 8;
    const ssss = entry & 0xff;
    if (ssss === 0) return 0;
    if (ssss === 16) return 32768;
    if (this.count < ssss) this.fill();
    const bits = (this.buffer >>> (this.count - ssss)) & ((1 << ssss) - 1);
    this.count -= ssss;
    return bits < 1 << (ssss - 1) ? bits - (1 << ssss) + 1 : bits;
  }

  /** Discards buffered bits and returns the offset of the next marker. */
  finish(): number {
    if (this.padding > this.count) throw new Lj92Error("Truncated lossless JPEG data");
    this.maxUnusedBits = Math.max(this.maxUnusedBits, this.unusedBits());
    const data = this.data;
    let position = this.position;
    while (position + 1 < data.length) {
      if (data[position] === 0xff) {
        const next = data[position + 1] as number;
        if (next !== 0x00 && next !== 0xff) return position;
      }
      position++;
    }
    throw new Lj92Error("Missing marker after scan data");
  }

  restart(): void {
    const marker = this.finish();
    const code = this.data[marker + 1] as number;
    if (code < 0xd0 || code > 0xd7) throw new Lj92Error("Missing restart marker");
    this.position = marker + 2;
    this.buffer = 0;
    this.count = 0;
    this.padding = 0;
    this.atMarker = false;
  }
}

function decodeScan(
  reader: BitReader,
  frame: Lj92Frame,
  scan: readonly ScanComponent[],
  predictor: number,
  restartInterval: number,
  out: Uint16Array,
): void {
  const { width, height, components, precision } = frame;
  const stride = width * components;
  const initial = 1 << (precision - 1);
  let rowsPerRestart = 0;
  if (restartInterval > 0) {
    if (restartInterval % width !== 0) {
      throw new Lj92Error("Restart intervals that split rows are not supported");
    }
    rowsPerRestart = restartInterval / width;
  }

  let firstRow = 0;
  for (let y = 0; y < height; y++) {
    if (rowsPerRestart > 0 && y > 0 && y % rowsPerRestart === 0) {
      reader.restart();
      firstRow = y;
    }
    const rowStart = y * stride;
    for (let x = 0; x < width; x++) {
      const pixel = rowStart + x * components;
      for (let s = 0; s < scan.length; s++) {
        const component = scan[s] as ScanComponent;
        const diff = reader.difference(component.table);
        const at = pixel + component.index;
        let prediction: number;
        if (y === firstRow) {
          prediction = x === 0 ? initial : (out[at - components] as number);
        } else if (x === 0) {
          prediction = out[at - stride] as number;
        } else {
          const ra = out[at - components] as number;
          const rb = out[at - stride] as number;
          const rc = out[at - stride - components] as number;
          switch (predictor) {
            case 1:
              prediction = ra;
              break;
            case 2:
              prediction = rb;
              break;
            case 3:
              prediction = rc;
              break;
            case 4:
              prediction = ra + rb - rc;
              break;
            case 5:
              prediction = ra + ((rb - rc) >> 1);
              break;
            case 6:
              prediction = rb + ((ra - rc) >> 1);
              break;
            default:
              prediction = (ra + rb) >> 1;
              break;
          }
        }
        out[at] = (prediction + diff) & 0xffff;
      }
    }
  }
}

export function decodeLj92(data: Uint8Array): Lj92Image {
  const read16 = (at: number): number => {
    if (at + 2 > data.length) throw new Lj92Error("Truncated lossless JPEG header");
    return ((data[at] as number) << 8) | (data[at + 1] as number);
  };

  if (data[0] !== 0xff || data[1] !== MARKER_SOI) throw new Lj92Error("Missing JPEG SOI marker");

  const tables: (Uint16Array | undefined)[] = [];
  let frame: Lj92Frame | undefined;
  let frameComponents: FrameComponent[] = [];
  let samples: Uint16Array<ArrayBuffer> | undefined;
  const covered: boolean[] = [];
  let restartInterval = 0;
  let unusedBits = 0;
  let position = 2;

  for (;;) {
    if (position >= data.length) throw new Lj92Error("Missing JPEG EOI marker");
    if (data[position] !== 0xff) throw new Lj92Error(`Expected a JPEG marker at byte ${position}`);
    while (data[position] === 0xff) position++;
    const marker = data[position++];
    if (marker === undefined) throw new Lj92Error("Missing JPEG EOI marker");
    if (marker === MARKER_EOI) break;
    if (marker === MARKER_SOI || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new Lj92Error(`Unexpected JPEG marker 0x${marker.toString(16)}`);
    }

    const length = read16(position);
    const start = position + 2;
    const end = position + length;
    if (length < 2 || end > data.length) throw new Lj92Error("Truncated JPEG segment");

    if (marker === MARKER_SOF3) {
      if (frame) throw new Lj92Error("Multiple JPEG frames");
      const precision = data[start] as number;
      const height = read16(start + 1);
      const width = read16(start + 3);
      const count = data[start + 5] as number;
      if (length !== 8 + 3 * count || count < 1 || count > 4) {
        throw new Lj92Error("Invalid lossless JPEG frame header");
      }
      if (precision < 2 || precision > 16) throw new Lj92Error(`Unsupported precision ${precision}`);
      if (width === 0 || height === 0) throw new Lj92Error("Lossless JPEG with unknown size");
      frameComponents = [];
      for (let i = 0; i < count; i++) {
        const sampling = data[start + 7 + i * 3] as number;
        if (sampling !== 0x11) throw new Lj92Error("Subsampled lossless JPEG is not supported");
        frameComponents.push({ id: data[start + 6 + i * 3] as number });
      }
      frame = { width, height, components: count, precision };
      samples = new Uint16Array(width * height * count);
    } else if (marker === MARKER_DHT) {
      let at = start;
      while (at < end) {
        const info = data[at] as number;
        const counts = data.subarray(at + 1, at + 17);
        let total = 0;
        for (const count of counts) total += count;
        const symbols = data.subarray(at + 17, at + 17 + total);
        if (counts.length !== 16 || symbols.length !== total || at + 17 + total > end) {
          throw new Lj92Error("Truncated Huffman table");
        }
        if (info >> 4 === 0) tables[info & 0x0f] = buildHuffmanTable(counts, symbols);
        at += 17 + total;
      }
    } else if (marker === MARKER_DRI) {
      restartInterval = read16(start);
    } else if (marker === MARKER_SOS) {
      if (!frame || !samples) throw new Lj92Error("Scan before frame header");
      const count = data[start] as number;
      if (length !== 6 + 2 * count || count < 1 || count > frame.components) {
        throw new Lj92Error("Invalid scan header");
      }
      const scan: ScanComponent[] = [];
      for (let i = 0; i < count; i++) {
        const id = data[start + 1 + i * 2] as number;
        const index = frameComponents.findIndex((component) => component.id === id);
        const table = tables[(data[start + 2 + i * 2] as number) >> 4];
        if (index < 0 || covered[index]) throw new Lj92Error("Invalid scan component");
        if (!table) throw new Lj92Error("Missing Huffman table");
        covered[index] = true;
        scan.push({ index, table });
      }
      const predictor = data[start + 1 + count * 2] as number;
      const pointTransform = (data[start + 3 + count * 2] as number) & 0x0f;
      if (predictor < 1 || predictor > 7) throw new Lj92Error(`Unsupported predictor ${predictor}`);
      if (pointTransform !== 0) throw new Lj92Error("Point transforms are not supported");
      const reader = new BitReader(data, end);
      decodeScan(reader, frame, scan, predictor, restartInterval, samples);
      position = reader.finish();
      unusedBits = Math.max(unusedBits, reader.maxUnusedBits);
      continue;
    } else if (marker === MARKER_DNL || (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc)) {
      throw new Lj92Error(`Unsupported JPEG process (marker 0x${marker.toString(16)})`);
    }
    position = end;
  }

  if (!frame || !samples) throw new Lj92Error("Missing lossless JPEG frame");
  for (let i = 0; i < frame.components; i++) {
    if (!covered[i]) throw new Lj92Error("Lossless JPEG component without scan data");
  }
  return { frame, samples, unusedBits };
}
