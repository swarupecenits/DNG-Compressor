// Minimal C ABI over libjxl used by the browser workers.
//
// Tiles are encoded the same way the Adobe DNG SDK encodes raw JPEG XL tiles:
// bits_per_sample equal to the container size (8 or 16), samples stored
// verbatim, and the original (linear) colour space kept. A bare codestream is
// requested, but 16-bit lossless data needs codestream level 10, which libjxl
// signals with a `jxll` box inside a minimal container (DNG accepts both).
// Verification decodes exactly like a DNG reader does (full-range output for
// the pixel format, no bit-depth override) and compares every sample.

#include <emscripten/emscripten.h>
#include <jxl/decode.h>
#include <jxl/encode.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace {

enum Result : int {
  kOk = 0,
  kBadArguments = 1,
  kOutOfMemory = 2,
  kEncoderSetup = 3,
  kEncoderFailed = 4,
  kDecoderFailed = 10,
  kGeometryMismatch = 11,
  kPixelMismatch = 12,
};

uint8_t* g_out = nullptr;
size_t g_out_size = 0;
size_t g_out_capacity = 0;

void ReleaseOutput() {
  free(g_out);
  g_out = nullptr;
  g_out_size = 0;
  g_out_capacity = 0;
}

bool ReserveOutput(size_t capacity) {
  if (capacity <= g_out_capacity) return true;
  auto* grown = static_cast<uint8_t*>(realloc(g_out, capacity));
  if (!grown) return false;
  g_out = grown;
  g_out_capacity = capacity;
  return true;
}

bool ValidLayout(uint32_t width, uint32_t height, uint32_t channels,
                 uint32_t bytes_per_sample) {
  return width > 0 && height > 0 && (channels == 1 || channels == 3) &&
         (bytes_per_sample == 1 || bytes_per_sample == 2);
}

JxlPixelFormat PixelFormat(uint32_t channels, uint32_t bytes_per_sample) {
  return JxlPixelFormat{channels,
                        bytes_per_sample == 1 ? JXL_TYPE_UINT8 : JXL_TYPE_UINT16,
                        JXL_NATIVE_ENDIAN, 0};
}

int EncodeLossless(JxlEncoder* enc, const void* pixels, uint32_t width,
                   uint32_t height, uint32_t channels,
                   uint32_t bytes_per_sample, int effort) {
  if (JxlEncoderUseContainer(enc, JXL_FALSE) != JXL_ENC_SUCCESS) {
    return kEncoderSetup;
  }

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize = width;
  info.ysize = height;
  info.intrinsic_xsize = width;
  info.intrinsic_ysize = height;
  info.bits_per_sample = bytes_per_sample * 8;
  info.exponent_bits_per_sample = 0;
  info.num_color_channels = channels;
  info.num_extra_channels = 0;
  info.alpha_bits = 0;
  info.uses_original_profile = JXL_TRUE;
  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) {
    return kEncoderSetup;
  }

  // Raw data is linear camera RGB; like the DNG SDK, tag it as linear Rec.2100.
  JxlColorEncoding color;
  memset(&color, 0, sizeof(color));
  color.color_space = channels == 1 ? JXL_COLOR_SPACE_GRAY : JXL_COLOR_SPACE_RGB;
  color.white_point = JXL_WHITE_POINT_D65;
  color.primaries = JXL_PRIMARIES_2100;
  color.transfer_function = JXL_TRANSFER_FUNCTION_LINEAR;
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) {
    return kEncoderSetup;
  }

  JxlEncoderFrameSettings* settings = JxlEncoderFrameSettingsCreate(enc, nullptr);
  if (!settings ||
      JxlEncoderSetFrameLossless(settings, JXL_TRUE) != JXL_ENC_SUCCESS ||
      JxlEncoderFrameSettingsSetOption(settings, JXL_ENC_FRAME_SETTING_EFFORT,
                                       effort) != JXL_ENC_SUCCESS) {
    return kEncoderSetup;
  }

  const JxlPixelFormat format = PixelFormat(channels, bytes_per_sample);
  const size_t input_bytes =
      static_cast<size_t>(width) * height * channels * bytes_per_sample;
  if (JxlEncoderAddImageFrame(settings, &format, pixels, input_bytes) !=
      JXL_ENC_SUCCESS) {
    return kEncoderFailed;
  }
  JxlEncoderCloseInput(enc);

  if (!ReserveOutput(input_bytes / 2 + 4096)) return kOutOfMemory;
  uint8_t* next = g_out;
  size_t available = g_out_capacity;
  JxlEncoderStatus status;
  while ((status = JxlEncoderProcessOutput(enc, &next, &available)) ==
         JXL_ENC_NEED_MORE_OUTPUT) {
    const size_t used = static_cast<size_t>(next - g_out);
    if (!ReserveOutput(g_out_capacity * 2)) return kOutOfMemory;
    next = g_out + used;
    available = g_out_capacity - used;
  }
  if (status != JXL_ENC_SUCCESS) return kEncoderFailed;
  g_out_size = static_cast<size_t>(next - g_out);
  return kOk;
}

int DecodeAndCompare(JxlDecoder* dec, const uint8_t* data, size_t size,
                     const void* expected, uint32_t width, uint32_t height,
                     uint32_t channels, uint32_t bytes_per_sample) {
  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) !=
          JXL_DEC_SUCCESS ||
      JxlDecoderSetKeepOrientation(dec, JXL_TRUE) != JXL_DEC_SUCCESS ||
      JxlDecoderSetInput(dec, data, size) != JXL_DEC_SUCCESS) {
    return kDecoderFailed;
  }
  JxlDecoderCloseInput(dec);

  const JxlPixelFormat format = PixelFormat(channels, bytes_per_sample);
  const size_t bytes =
      static_cast<size_t>(width) * height * channels * bytes_per_sample;
  void* decoded = nullptr;
  int result = kDecoderFailed;

  for (;;) {
    const JxlDecoderStatus status = JxlDecoderProcessInput(dec);
    if (status == JXL_DEC_BASIC_INFO) {
      JxlBasicInfo info;
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) break;
      if (info.xsize != width || info.ysize != height ||
          info.num_color_channels != channels || info.num_extra_channels != 0 ||
          info.exponent_bits_per_sample != 0 ||
          info.bits_per_sample != bytes_per_sample * 8) {
        result = kGeometryMismatch;
        break;
      }
    } else if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t needed = 0;
      if (JxlDecoderImageOutBufferSize(dec, &format, &needed) != JXL_DEC_SUCCESS ||
          needed != bytes) {
        result = kGeometryMismatch;
        break;
      }
      decoded = malloc(bytes);
      if (!decoded) {
        result = kOutOfMemory;
        break;
      }
      if (JxlDecoderSetImageOutBuffer(dec, &format, decoded, bytes) !=
          JXL_DEC_SUCCESS) {
        break;
      }
    } else if (status == JXL_DEC_FULL_IMAGE) {
      continue;
    } else if (status == JXL_DEC_SUCCESS) {
      result = decoded && memcmp(decoded, expected, bytes) == 0 ? kOk
                                                                 : kPixelMismatch;
      break;
    } else {
      break;
    }
  }

  free(decoded);
  return result;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void* dng_alloc(size_t size) { return malloc(size); }

EMSCRIPTEN_KEEPALIVE void dng_free(void* ptr) { free(ptr); }

EMSCRIPTEN_KEEPALIVE uint8_t* dng_out_ptr() { return g_out; }

EMSCRIPTEN_KEEPALIVE size_t dng_out_size() { return g_out_size; }

EMSCRIPTEN_KEEPALIVE void dng_out_release() { ReleaseOutput(); }

EMSCRIPTEN_KEEPALIVE uint32_t dng_jxl_version() { return JxlEncoderVersion(); }

// Encodes interleaved samples losslessly. On success the codestream is
// available through dng_out_ptr()/dng_out_size() until the next call.
EMSCRIPTEN_KEEPALIVE int dng_jxl_encode(const void* pixels, uint32_t width,
                                        uint32_t height, uint32_t channels,
                                        uint32_t bytes_per_sample, int effort) {
  ReleaseOutput();
  if (!pixels || !ValidLayout(width, height, channels, bytes_per_sample) ||
      effort < 1 || effort > 10) {
    return kBadArguments;
  }
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (!enc) return kOutOfMemory;
  const int result =
      EncodeLossless(enc, pixels, width, height, channels, bytes_per_sample, effort);
  JxlEncoderDestroy(enc);
  if (result != kOk) ReleaseOutput();
  return result;
}

// Returns 0 when `data` decodes to exactly `expected`.
EMSCRIPTEN_KEEPALIVE int dng_jxl_verify(const uint8_t* data, size_t size,
                                        const void* expected, uint32_t width,
                                        uint32_t height, uint32_t channels,
                                        uint32_t bytes_per_sample) {
  if (!data || !size || !expected ||
      !ValidLayout(width, height, channels, bytes_per_sample)) {
    return kBadArguments;
  }
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (!dec) return kOutOfMemory;
  const int result = DecodeAndCompare(dec, data, size, expected, width, height,
                                      channels, bytes_per_sample);
  JxlDecoderDestroy(dec);
  return result;
}

}  // extern "C"
