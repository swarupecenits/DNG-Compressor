#!/usr/bin/env python3
"""Independent check of a DNG Squeeze result against its original.

    python tools/verify-dng.py ORIGINAL.dng COMPRESSED.dng

Requires `pip install tifffile imagecodecs numpy`. The main raw image of both
files is decoded with tifffile and imagecodecs (native libjpeg-turbo and
libjxl, not the web app's code) and must match sample for sample. Every other
image must keep its stored bytes, and every tag (including Exif) its value,
apart from the expected DNG 1.7 updates.
"""

import sys

import numpy as np
import tifffile

LJ92 = 7
JPEG_XL = 52546
RAW_PHOTOMETRIC = {32803, 34892}
# Tags of the main raw image that the rewrite replaces.
MAIN_TAGS = {259, 324, 325, 52553, 52554, 52555}
VERSION_TAGS = {50706, 50707}


def image_ifds(tif):
    """Every image IFD (IFD chain and SubIFDs) keyed by its position."""
    found = {}

    def visit(page, path):
        found[path] = page
        for i, sub in enumerate(page.pages or ()):
            visit(sub, f"{path}/sub{i}")

    for i, page in enumerate(tif.pages):
        visit(page, f"ifd{i}")
    return found


def is_main(page):
    subfile = page.tags.get(254)
    return (subfile.value if subfile else 0) == 0 and page.photometric in RAW_PHOTOMETRIC


def same(a, b):
    if isinstance(a, np.ndarray) or isinstance(b, np.ndarray):
        return np.array_equal(np.asarray(a), np.asarray(b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


def stored_bytes(tif, page):
    chunks = []
    for offset, length in zip(page.dataoffsets, page.databytecounts):
        tif.filehandle.seek(offset)
        chunks.append(tif.filehandle.read(length))
    return chunks


def main(original_path, compressed_path):
    problems = []
    with tifffile.TiffFile(original_path) as original, tifffile.TiffFile(compressed_path) as compressed:
        before, after = image_ifds(original), image_ifds(compressed)
        if before.keys() != after.keys():
            problems.append(f"image IFDs differ: {sorted(before)} vs {sorted(after)}")
        mains = [path for path, page in before.items() if is_main(page)]
        if len(mains) != 1:
            problems.append(f"expected one main raw image, found {mains}")

        for path in sorted(before.keys() & after.keys()):
            old, new = before[path], after[path]
            skip = MAIN_TAGS if path in mains else set()
            if path == "ifd0":
                skip = skip | VERSION_TAGS
            old_tags = {tag.code: tag.value for tag in old.tags if tag.code not in skip}
            new_tags = {tag.code: tag.value for tag in new.tags if tag.code not in skip}
            # The SubIFDs entry that points at the main image moves to the new copy.
            for main_path in mains:
                parent, _, leaf = main_path.rpartition("/")
                if parent == path and leaf.startswith("sub") and 330 in old_tags and 330 in new_tags:
                    index = int(leaf[3:])
                    old_tags[330] = [v for i, v in enumerate(np.atleast_1d(old_tags[330])) if i != index]
                    new_tags[330] = [v for i, v in enumerate(np.atleast_1d(new_tags[330])) if i != index]
            for code in sorted(old_tags.keys() | new_tags.keys()):
                if not same(old_tags.get(code), new_tags.get(code)):
                    problems.append(f"{path}: tag {code} changed")

            if path not in mains:
                if stored_bytes(original, old) != stored_bytes(compressed, new):
                    problems.append(f"{path}: image data differs")
                continue
            if old.compression != LJ92 or new.compression != JPEG_XL:
                problems.append(f"{path}: compression {old.compression} -> {new.compression}")
            old_pixels, new_pixels = old.asarray(), new.asarray()
            if old_pixels.dtype != new_pixels.dtype or not np.array_equal(old_pixels, new_pixels):
                problems.append(f"{path}: raw pixels differ")
            else:
                print(f"{path}: {'x'.join(map(str, old_pixels.shape))} {old_pixels.dtype} raw image is identical")

        for code, name in ((50706, "DNGVersion"), (50707, "DNGBackwardVersion")):
            tag = compressed.pages[0].tags.get(code)
            if (tag is None and code == 50706) or (tag is not None and tuple(tag.value) < (1, 7, 0, 0)):
                problems.append(f"{name} is {tag and tag.value}, expected 1.7 or later")

    if problems:
        print("FAILED:\n  " + "\n  ".join(problems))
        return 1
    print("OK: lossless, and everything else is unchanged.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
