import { describe, expect, it } from "vitest";
import { formatBytes, formatChange, formatDuration, formatEta, outputName } from "../src/lib/format.ts";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1000, "1.0 KB"],
    [99_949, "99.9 KB"],
    [99_950, "100 KB"],
    [999_499, "999 KB"],
    [999_950, "1.0 MB"],
    [29_195_592, "29.2 MB"],
    [123_456_789, "123 MB"],
    [1_500_000_000, "1.5 GB"],
    [-7_600_000, "−7.6 MB"],
  ])("%d -> %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("formatChange", () => {
  it.each([
    [100, 74, "−26%"],
    [29_195_592, 21_550_000, "−26%"],
    [100, 95.04, "−5%"],
    [1000, 1001, "+0.1%"],
    [100, 99.96, "0%"],
    [100, 100, "0%"],
    [0, 10, "0%"],
  ])("%d -> %d is %s", (before, after, text) => {
    expect(formatChange(before, after)).toBe(text);
  });
});

describe("formatDuration", () => {
  it.each([
    [-20, "0.0 s"],
    [4_200, "4.2 s"],
    [9_949, "9.9 s"],
    [9_950, "10 s"],
    [59_499, "59 s"],
    [59_500, "1 min"],
    [75_000, "1 min 15 s"],
    [119_600, "2 min"],
  ])("%d ms -> %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("formatEta", () => {
  it.each([
    [-1, "a few seconds left"],
    [4_999, "a few seconds left"],
    [42_000, "about 40 s left"],
    [53_000, "about 55 s left"],
    [55_000, "about a minute left"],
    [89_000, "about a minute left"],
    [150_000, "about 3 min left"],
  ])("%d ms -> %s", (ms, text) => {
    expect(formatEta(ms)).toBe(text);
  });
});

describe("outputName", () => {
  it.each([
    ["IMG_0042.DNG", "IMG_0042-jxl.DNG"],
    ["IMG_0042.dng", "IMG_0042-jxl.dng"],
    ["holiday.photo.DnG", "holiday.photo-jxl.DnG"],
    ["IMG_0042", "IMG_0042-jxl.dng"],
    [".dng", "photo-jxl.dng"],
    ["", "photo-jxl.dng"],
  ])("%j -> %j", (name, result) => {
    expect(outputName(name)).toBe(result);
  });
});
