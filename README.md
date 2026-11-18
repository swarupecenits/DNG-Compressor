# DNG Squeeze

DNG Squeeze is a lossless compressor for Apple ProRAW photos that runs entirely in your browser. It re-encodes the raw
image inside each DNG with lossless JPEG XL. Files get about a quarter smaller, and every pixel stays identical. It's
free and needs no sign-up. It works offline, and your photos are never uploaded.

| | |
| --- | --- |
| Example | iPhone 12 Pro, 12 MP ProRAW: 29.2 MB → 21.6 MB (−26%) |
| Speed | About 5 s per 12 MP photo in a desktop browser; phones take longer |
| Proof | Every re-encoded tile is decoded again and compared value by value before it is used |
| Output | `IMG_1234-jxl.DNG`, a DNG 1.7 file. The original file is never modified. |

## Using it on iPhone

1. In Photos, open a ProRAW photo, then tap **Share → Save to Files**.
2. Open the site in Safari. Tap **Choose DNG files → Choose File** (or **Browse**) and select the files. Don't pick
   straight from the photo library: it can hand over a JPEG instead of the DNG.
3. When a photo is done, tap **Save → Save to Files**. Keep the screen on while it works. The app asks iOS to keep the
   screen awake, but iOS pauses pages that are in the background.
4. Optional: tap **Share → Add to Home Screen** to install the app. After the first visit it also works offline.

On a computer, drop the files onto the page. In Chrome or Edge you can also install the app. Once installed, it
appears in **Open with** for `.dng` files.

> Check that the compressed copies open in the apps you use before you delete any originals.

## Compatibility

DNG 1.7 added JPEG XL support. These apps read the compressed files:

- Apple Photos and Preview on iOS 18 and macOS 15 or later.
- Current versions of Adobe Lightroom and Camera Raw.

Older apps may refuse the files or show only the embedded preview.

iPhone 16 Pro and later can capture ProRAW as JPEG XL directly. DNG Squeeze is for older iPhones and for the photos
you already have.

## Supported files

- **Supported:** linear DNGs whose main image uses lossless JPEG. That means PhotometricInterpretation `LinearRaw`
  and Compression 7, tiled, 8–16 bits, with 1 or 3 samples per pixel. Apple ProRAW uses this format.
- **Layout:** the main image's tiles must be at the end of the file, as they are in ProRAW. Everything before them is
  then kept byte for byte.
- **Not supported:** Bayer (CFA) raw files. DNG 1.7 doesn't allow JPEG XL for them, so they are left alone.
- **Skipped:** files that already use JPEG XL.

## Compression levels

| Setting | libjxl effort | Saved | Encode time, 1 thread |
| --- | --- | --- | --- |
| Fast | 3 | 21.0% | 5.1 s |
| Balanced (default) | 5 | 26.2% | 16.0 s |
| Smallest | 7 | 26.7% | 28.5 s |

These figures were measured on the 12 MP iPhone 12 Pro sample. The app spreads the tiles over Web Workers: up to 8
on a computer, leaving one core for the page, and up to 4 on a phone.

## How it works

ProRAW stores its main image as a grid of tiles. Each tile is compressed with lossless JPEG (ITU T.81 process 14,
known as "LJ92"). For each file, DNG Squeeze does the following:

1. **Plan.** It reads the start of the file and parses the TIFF structure. It finds the main raw image and checks the
   layout. The code is in `src/lib/tiff.ts` and `src/lib/dng.ts`.
2. **Re-encode.** It reads each tile and decodes it with `src/lib/lj92.ts`. It then encodes the tile with libjxl at
   distance 0, which is mathematically lossless. Finally it decodes the new tile and compares every sample with the
   original. The code is in `src/lib/jxl.ts` and `wasm/jxl_tile.cc`. Tiles run in a pool of Web Workers
   (`src/worker/`).
3. **Assemble.** It builds the new file in `src/compress.ts`, in three parts:
   - the original bytes up to the old tiles. Only the version tags (set to DNG 1.7.0.0) and the pointer to the main
     image change.
   - the new JPEG XL tiles.
   - a new IFD for the main image, with Compression 52546 and the JPEG XL tags.

   Previews, Exif and GPS data, semantic masks and all other metadata are copied byte for byte. The result is built
   from slices of the original file, so memory use stays low.

libjxl 0.13 is compiled to single-threaded SIMD WebAssembly in `src/wasm/`. The module is 2.4 MB, and the service
worker caches it with the rest of the app.

## Privacy

Everything happens in your browser:

- The page loads only its own files. There are no analytics, web fonts, CDNs or trackers.
- The production build sets a strict Content-Security-Policy that blocks connections to any other origin.
- Photos are read with the File API and processed in Web Workers. They are saved with the share sheet or as a
  download.

## Development

You need Node.js 22.13 or later; the 24 LTS release is recommended.

| Command | What it does |
| --- | --- |
| `npm install` | Installs the dev tools. The app itself has no runtime dependencies. |
| `npm run dev` | Starts a dev server with hot reload. The CSP and service worker are only added in builds. |
| `npm run build` | Type-checks, then builds the static site into `dist/` |
| `npm run preview` | Serves `dist/` locally |
| `npm test` | Runs the unit tests |
| `npm run lint` / `npm run typecheck` | Runs ESLint / TypeScript |
| `npm run build:wasm` | Rebuilds libjxl as WebAssembly (see below) |

```text
src/
  main.ts        UI: picking files, queue, progress, saving, install and updates
  compress.ts    plans and rewrites one file using the worker pool
  engine.ts      loads the WebAssembly module and checks browser support
  thumbnail.ts   thumbnails from the DNG's embedded preview
  lib/           TIFF reader, DNG planning and assembly, LJ92 decoder, libjxl wrapper, formatting
  worker/        tile worker and pool
  wasm/          prebuilt libjxl WebAssembly (generated)
wasm/            C++ glue and build script for the WebAssembly module
tests/           unit tests, fixtures and the real-file test
tools/           fixture generator and independent verifier (Python)
```

### Tests

- `tests/lj92.test.ts` decodes lossless JPEG streams written by libjpeg-turbo and checks every sample. The streams
  cover all seven predictors, 8–16 bits and restart intervals. `tools/make-lj92-fixtures.py` generates them into
  `tests/fixtures/lj92.json`.
- `tests/dng.test.ts` builds synthetic ProRAW-like DNGs in both byte orders with `tests/tiff-builder.ts`. It checks
  the analysis, the rewritten file, and that unsupported or corrupt files are rejected.
- `tests/sample.test.ts` runs the whole pipeline on a real DNG when `DNG_SAMPLE` is set:

```powershell
$env:DNG_SAMPLE = 'C:\Photos\IMG_1234.DNG'
$env:DNG_OUT = 'C:\Photos\IMG_1234-jxl.DNG'   # optional: keep the result
$env:DNG_EFFORT = '7'                          # optional, default 5
npm test
```

`tools/verify-dng.py` checks a result independently of the app's own code. It uses native libjpeg-turbo and libjxl
through `imagecodecs`. The main image must match the original sample for sample. Every other image and tag must be
unchanged, apart from the DNG 1.7 updates.

```powershell
pip install tifffile imagecodecs numpy
python tools/verify-dng.py C:\Photos\IMG_1234.DNG C:\Photos\IMG_1234-jxl.DNG
```

### Rebuilding the WebAssembly module

The prebuilt module in `src/wasm/` is all the app needs. To change the encoder:

1. Edit `wasm/jxl_tile.cc`.
2. Run `npm run build:wasm`. It needs Windows with PowerShell 7, Git and Python 3.

The script downloads emsdk, CMake, Ninja and libjxl v0.13.0 into `%LOCALAPPDATA%\dng-squeeze-toolchain`. That folder
takes about 2.4 GB, and you can delete it afterwards. The script writes `src/wasm/jxl_tile.mjs` and `jxl_tile.wasm`.

## Deploying

`npm run build` writes a static site to `dist/`. It uses relative paths, so it works from any folder on any static
host, such as GitHub Pages, Cloudflare Pages, Netlify or Vercel. It must be served over HTTPS so the service worker
and installing work; `localhost` is fine for testing.

`.github/workflows/deploy.yml` publishes the site to GitHub Pages:

1. Push the project to a GitHub repository.
2. Under **Settings → Pages**, set **Source** to **GitHub Actions**.

Every push to `main` then runs the lint, the tests and the build, and deploys the site.

## Licenses

The JPEG XL encoder is [libjxl](https://github.com/libjxl/libjxl) 0.13.0 (BSD 3-Clause), with Highway, Brotli and
skcms, compiled with Emscripten. Their notices ship with the app in `public/third-party-licenses.txt`.
