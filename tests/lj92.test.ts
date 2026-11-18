import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Lj92Error, decodeLj92 } from "../src/lib/lj92.ts";
import { decodeTile } from "../src/lib/tile.ts";

/** A stream written by tools/make-lj92-fixtures.py. */
interface Fixture {
  readonly encoder: string;
  readonly width: number;
  readonly height: number;
  readonly components: number;
  readonly bits: number;
  readonly predictor: number;
  readonly restartRows: number;
  readonly data: string;
}

const { cases } = JSON.parse(readFileSync(new URL("./fixtures/lj92.json", import.meta.url), "utf8")) as {
  cases: Fixture[];
};

/** The samples every fixture holds (same pattern as the generator), row-major and interleaved. */
function pattern({ width, height, components, bits }: Fixture): Uint16Array {
  const mask = 2 ** bits - 1;
  const out = new Uint16Array(width * height * components);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < components; c++) {
        const k = (x + 2 * y + 3 * c) % 9;
        if (k === 0) out[i++] = mask;
        else if (k === 4) out[i++] = 0;
        else if (k === 5) out[i++] = 2 ** (bits - 1);
        else out[i++] = ((x * 73856093) ^ (y * 19349663) ^ (c * 83492791)) & mask;
      }
    }
  }
  return out;
}

const bytesOf = (fixture: Fixture): Uint8Array => new Uint8Array(Buffer.from(fixture.data, "base64"));

function fixture(predicate: (f: Fixture) => boolean): Fixture {
  const found = cases.find(predicate);
  if (!found) throw new Error("missing fixture");
  return found;
}

function describeFixture(f: Fixture): string {
  const restart = f.restartRows ? `, restart every ${f.restartRows} row(s)` : "";
  return `${f.bits}-bit ${f.components === 3 ? "RGB" : "gray"} ${f.width}x${f.height}, predictor ${f.predictor}${restart} (${f.encoder})`;
}

describe("decodeLj92", () => {
  it("has fixtures for every predictor and for restart intervals", () => {
    expect(new Set(cases.map((f) => f.predictor))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
    expect(cases.some((f) => f.restartRows > 0)).toBe(true);
  });

  it.each(cases.map((f) => [describeFixture(f), f] as const))("decodes %s", (_, f) => {
    const { frame, samples, unusedBits } = decodeLj92(bytesOf(f));
    expect(frame).toEqual({ width: f.width, height: f.height, components: f.components, precision: f.bits });
    expect(samples).toEqual(pattern(f));
    expect(unusedBits).toBeLessThanOrEqual(7);
  });

  it("rejects data that isn't lossless JPEG", () => {
    expect(() => decodeLj92(Uint8Array.of(0x00, 0x01, 0x02))).toThrow(/SOI/);
    const baseline = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9);
    expect(() => decodeLj92(baseline)).toThrow(/Unsupported JPEG process/);
  });

  it("rejects truncated data", () => {
    const data = bytesOf(fixture((f) => f.components === 3 && f.restartRows === 0));
    for (const end of [3, 40, data.length >> 1, data.length - 2]) {
      expect(() => decodeLj92(data.subarray(0, end)), `cut at ${end} bytes`).toThrow(Lj92Error);
    }
  });
});

describe("decodeTile", () => {
  const rgb16 = fixture((f) => f.bits === 16 && f.components === 3 && f.restartRows === 0);
  const gray12 = fixture((f) => f.bits === 12);
  const gray8 = fixture((f) => f.bits === 8);
  const tileOf = (f: Fixture, bytesPerSample: 1 | 2) => ({
    data: bytesOf(f),
    tileWidth: f.width,
    tileLength: f.height,
    samplesPerPixel: f.components,
    bytesPerSample,
  });

  it("returns 16-bit samples for 2-byte raws", () => {
    const samples = decodeTile(tileOf(rgb16, 2));
    expect(samples).toBeInstanceOf(Uint16Array);
    expect(samples).toEqual(pattern(rgb16));
  });

  it("returns bytes for 8-bit raws", () => {
    const samples = decodeTile(tileOf(gray8, 1));
    expect(samples).toBeInstanceOf(Uint8Array);
    expect(samples).toEqual(Uint8Array.from(pattern(gray8)));
  });

  it("rejects tiles that don't match the raw image", () => {
    expect(() => decodeTile({ ...tileOf(rgb16, 2), tileWidth: rgb16.width + 1 })).toThrow(/instead of/);
    expect(() => decodeTile(tileOf(gray12, 1))).toThrow(/above 255/);
  });
});
