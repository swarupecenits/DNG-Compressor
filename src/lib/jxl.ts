/** Lossless JPEG XL tile encoder backed by libjxl compiled to WebAssembly. */

import createJxlModule, { type JxlModule } from "../wasm/jxl_tile.mjs";

const MESSAGES: Record<number, string> = {
  1: "invalid arguments",
  2: "out of memory",
  3: "encoder setup failed",
  4: "encoding failed",
  10: "decoding failed",
  11: "decoded image has the wrong size",
  12: "decoded pixels differ from the original",
};

export class JxlError extends Error {
  constructor(
    readonly code: number,
    stage: string,
  ) {
    super(`JPEG XL ${stage}: ${MESSAGES[code] ?? `error ${code}`}`);
    this.name = "JxlError";
  }
}

export class JxlCodec {
  private constructor(private readonly module: JxlModule) {}

  /** Instantiates the codec from a compiled module or the raw .wasm bytes. */
  static async create(wasm: WebAssembly.Module | BufferSource): Promise<JxlCodec> {
    const compiled = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
    const module = await new Promise<JxlModule>((resolve, reject) => {
      createJxlModule({
        instantiateWasm(imports, done) {
          WebAssembly.instantiate(compiled, imports).then(done, reject);
          return {};
        },
        printErr: () => {},
      }).then(resolve, reject);
    });
    return new JxlCodec(module);
  }

  /** libjxl version, e.g. "0.13.0". */
  get version(): string {
    const v = this.module._dng_jxl_version();
    return `${Math.floor(v / 1_000_000)}.${Math.floor(v / 1000) % 1000}.${v % 1000}`;
  }

  /**
   * Encodes interleaved samples as lossless JPEG XL, then decodes the result
   * and checks that every sample round-trips exactly.
   */
  encodeLossless(
    samples: Uint8Array | Uint16Array,
    width: number,
    height: number,
    channels: number,
    effort: number,
  ): Uint8Array<ArrayBuffer> {
    const m = this.module;
    const bytesPerSample = samples.BYTES_PER_ELEMENT;
    if (samples.length !== width * height * channels) throw new JxlError(1, "encoder");
    const input = m._dng_alloc(samples.byteLength);
    if (!input) throw new JxlError(2, "encoder");
    try {
      m.HEAPU8.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), input);
      const encoded = m._dng_jxl_encode(input, width, height, channels, bytesPerSample, effort);
      if (encoded !== 0) throw new JxlError(encoded, "encoder");
      const output = m._dng_out_ptr();
      const size = m._dng_out_size();
      const verified = m._dng_jxl_verify(output, size, input, width, height, channels, bytesPerSample);
      if (verified !== 0) throw new JxlError(verified, "verification");
      return m.HEAPU8.slice(output, output + size);
    } finally {
      m._dng_out_release();
      m._dng_free(input);
    }
  }
}
