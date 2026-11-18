#!/usr/bin/env python3
"""Writes tests/fixtures/lj92.json, the lossless JPEG streams of the decoder tests.

    python tools/make-lj92-fixtures.py

Requires `pip install imagecodecs numpy`. Most streams come from libjpeg-turbo
(through imagecodecs). It can't write restart intervals, so those streams come
from the small encoder below, and every stream is checked by decoding it with
libjpeg-turbo. The tests rebuild the expected samples with the same pattern.
"""

import base64
import json
import pathlib

import imagecodecs
import numpy as np

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "lj92.json"


def pattern(width, height, components, bits):
    """Noisy samples with full-scale jumps. Keep in sync with tests/lj92.test.ts."""
    mask = (1 << bits) - 1
    out = np.zeros((height, width, components), np.uint16)
    for y in range(height):
        for x in range(width):
            for c in range(components):
                k = (x + 2 * y + 3 * c) % 9
                if k == 0:
                    value = mask
                elif k == 4:
                    value = 0
                elif k == 5:
                    value = 1 << (bits - 1)
                else:
                    value = ((x * 73856093) ^ (y * 19349663) ^ (c * 83492791)) & mask
                out[y, x, c] = value
    return out


def libjpeg_turbo(samples, bits, predictor):
    data = samples if samples.shape[2] > 1 else samples[:, :, 0]
    if bits <= 8:
        data = data.astype(np.uint8)
    rgb = "RGB" if samples.shape[2] == 3 else None
    return imagecodecs.jpeg8_encode(
        data, lossless=True, predictor=predictor, bitspersample=bits, colorspace=rgb, outcolorspace=rgb
    )


class BitWriter:
    def __init__(self):
        self.out = bytearray()
        self.acc = 0
        self.count = 0

    def put(self, value, length):
        for i in range(length - 1, -1, -1):
            self.acc = (self.acc << 1) | ((value >> i) & 1)
            self.count += 1
            if self.count == 8:
                self.out.append(self.acc)
                if self.acc == 0xFF:
                    self.out.append(0)  # byte stuffing
                self.acc = 0
                self.count = 0

    def flush(self):
        while self.count:
            self.put(1, 1)


def with_restarts(samples, bits, predictor, rows):
    """ITU-T T.81 lossless encoder with a restart interval of `rows` rows.

    A single Huffman table gives each of the 17 difference categories a 5-bit
    code; the codes don't need to be efficient.
    """
    height, width, components = samples.shape
    s = samples.astype(np.int64)
    out = bytearray(b"\xff\xd8")

    def segment(marker, payload):
        out.extend(bytes([0xFF, marker]) + (len(payload) + 2).to_bytes(2, "big") + bytes(payload))

    ids = range(1, components + 1)
    sof = bytes([bits]) + height.to_bytes(2, "big") + width.to_bytes(2, "big") + bytes([components])
    segment(0xC3, sof + b"".join(bytes([i, 0x11, 0]) for i in ids))
    counts = [0] * 16
    counts[4] = 17
    segment(0xC4, bytes([0x00] + counts + list(range(17))))
    segment(0xDD, (rows * width).to_bytes(2, "big"))
    segment(0xDA, bytes([components]) + b"".join(bytes([i, 0x00]) for i in ids) + bytes([predictor, 0, 0]))

    writer = BitWriter()
    for y in range(height):
        if y and y % rows == 0:
            writer.flush()
            writer.out.extend(bytes([0xFF, 0xD0 + (y // rows - 1) % 8]))
        first = y - y % rows
        for x in range(width):
            for c in range(components):
                if y == first:
                    prediction = 1 << (bits - 1) if x == 0 else s[y, x - 1, c]
                elif x == 0:
                    prediction = s[y - 1, x, c]
                else:
                    ra, rb, rc = s[y, x - 1, c], s[y - 1, x, c], s[y - 1, x - 1, c]
                    prediction = (
                        None,
                        ra,
                        rb,
                        rc,
                        ra + rb - rc,
                        ra + ((rb - rc) >> 1),
                        rb + ((ra - rc) >> 1),
                        (ra + rb) >> 1,
                    )[predictor]
                diff = int(s[y, x, c] - prediction) % 65536
                if diff >= 32768:
                    diff -= 65536
                if diff == -32768:
                    writer.put(16, 5)  # category 16 has no extra bits
                    continue
                category = abs(diff).bit_length()
                writer.put(category, 5)
                if category:
                    writer.put(diff if diff > 0 else diff + (1 << category) - 1, category)
    writer.flush()
    out.extend(writer.out)
    out.extend(b"\xff\xd9")
    return bytes(out)


CASES = [
    # (width, height, components, bits, predictor, restart rows)
    *[(19, 7, 3, 16, predictor, 0) for predictor in range(1, 8)],
    (23, 9, 1, 12, 1, 0),
    (23, 9, 1, 12, 4, 0),
    (16, 5, 1, 8, 7, 0),
    (13, 9, 3, 16, 6, 2),
    (11, 11, 1, 14, 1, 1),
]


def main():
    cases = []
    for width, height, components, bits, predictor, rows in CASES:
        samples = pattern(width, height, components, bits)
        if rows:
            data = with_restarts(samples, bits, predictor, rows)
            encoder = "tools/make-lj92-fixtures.py"
        else:
            data = libjpeg_turbo(samples, bits, predictor)
            encoder = imagecodecs.jpeg8_version()
        decoded = imagecodecs.jpeg8_decode(data).reshape(samples.shape)
        if not np.array_equal(decoded, samples):
            raise SystemExit(f"libjpeg-turbo disagrees on {width}x{height}x{components} predictor {predictor}")
        cases.append(
            {
                "encoder": encoder,
                "width": width,
                "height": height,
                "components": components,
                "bits": bits,
                "predictor": predictor,
                "restartRows": rows,
                "data": base64.b64encode(data).decode("ascii"),
            }
        )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"cases": cases}, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {len(cases)} streams to {OUT}")


if __name__ == "__main__":
    main()
