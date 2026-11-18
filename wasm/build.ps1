<#
.SYNOPSIS
  Rebuilds src/wasm/jxl_tile.mjs + jxl_tile.wasm (libjxl compiled to WebAssembly).

.DESCRIPTION
  Only needed when changing the encoder: the prebuilt module is committed in src/wasm.
  Downloads emsdk, CMake/Ninja (pip) and libjxl into a toolchain cache folder outside the
  repository, builds libjxl as a single-threaded SIMD WebAssembly library and links the thin
  C ABI in wasm/jxl_tile.cc. Delete the toolchain folder afterwards to reclaim disk space.
#>
[CmdletBinding()]
param(
  [string]$Toolchain = (Join-Path $env:LOCALAPPDATA 'dng-squeeze-toolchain'),
  [string]$EmsdkVersion = 'latest',
  [string]$LibjxlVersion = 'v0.13.0'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$emsdk = Join-Path $Toolchain 'emsdk'
$py = Join-Path $Toolchain 'py'
$libjxl = Join-Path $Toolchain 'libjxl'
$build = Join-Path $Toolchain 'build-wasm'
$outDir = Join-Path $repo 'src\wasm'

function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Exe failed with exit code $LASTEXITCODE" }
}

New-Item -ItemType Directory -Force $Toolchain, $outDir | Out-Null

if (-not (Test-Path (Join-Path $emsdk 'emsdk.bat'))) {
  Invoke-Checked git @('clone', '--depth', '1', 'https://github.com/emscripten-core/emsdk.git', $emsdk)
}
Invoke-Checked (Join-Path $emsdk 'emsdk.bat') @('install', $EmsdkVersion)
Invoke-Checked (Join-Path $emsdk 'emsdk.bat') @('activate', $EmsdkVersion)
$emscripten = Join-Path $emsdk 'upstream\emscripten'

if (-not (Test-Path (Join-Path $py 'Scripts\cmake.exe'))) {
  Invoke-Checked python @('-m', 'venv', $py)
  Invoke-Checked (Join-Path $py 'Scripts\python.exe') @('-m', 'pip', 'install', '--quiet', 'cmake', 'ninja')
}
$cmake = Join-Path $py 'Scripts\cmake.exe'
$ninja = Join-Path $py 'Scripts\ninja.exe'

if (-not (Test-Path (Join-Path $libjxl 'CMakeLists.txt'))) {
  Invoke-Checked git @('-c', 'advice.detachedHead=false', 'clone', '--depth', '1', '--branch', $LibjxlVersion,
    'https://github.com/libjxl/libjxl.git', $libjxl)
  Invoke-Checked git @('-C', $libjxl, 'submodule', 'update', '--init', '--depth', '1',
    'third_party/brotli', 'third_party/highway', 'third_party/skcms')
}

# Single-threaded (parallelism comes from one Web Worker per tile), SIMD128, encoder + decoder only.
$simd = '-msimd128 -DHWY_COMPILE_ONLY_STATIC=1'
Invoke-Checked (Join-Path $emscripten 'emcmake.exe') @(
  $cmake, '-S', $libjxl, '-B', $build, '-G', 'Ninja', "-DCMAKE_MAKE_PROGRAM=$ninja",
  '-DCMAKE_BUILD_TYPE=Release', "-DCMAKE_C_FLAGS=$simd", "-DCMAKE_CXX_FLAGS=$simd",
  '-DBUILD_SHARED_LIBS=OFF', '-DBUILD_TESTING=OFF',
  '-DJPEGXL_ENABLE_TOOLS=OFF', '-DJPEGXL_ENABLE_DOXYGEN=OFF', '-DJPEGXL_ENABLE_MANPAGES=OFF',
  '-DJPEGXL_ENABLE_BENCHMARK=OFF', '-DJPEGXL_ENABLE_EXAMPLES=OFF', '-DJPEGXL_ENABLE_JNI=OFF',
  '-DJPEGXL_ENABLE_SJPEG=OFF', '-DJPEGXL_ENABLE_OPENEXR=OFF', '-DJPEGXL_ENABLE_FUZZERS=OFF',
  '-DJPEGXL_ENABLE_DEVTOOLS=OFF', '-DJPEGXL_ENABLE_PLUGINS=OFF', '-DJPEGXL_ENABLE_VIEWERS=OFF',
  '-DJPEGXL_ENABLE_TRANSCODE_JPEG=OFF', '-DJPEGXL_ENABLE_BOXES=OFF', '-DJPEGXL_BUNDLE_LIBPNG=OFF',
  '-DJPEGXL_ENABLE_WASM_THREADS=OFF', '-DJPEGXL_ENABLE_SKCMS=ON'
)
Invoke-Checked $cmake @('--build', $build, '--target', 'jxl', 'jxl_cms', 'brotlidec')

$libs = @(
  'lib\libjxl.a', 'lib\libjxl_cms.a', 'third_party\highway\libhwy.a',
  'third_party\brotli\libbrotlienc.a', 'third_party\brotli\libbrotlidec.a', 'third_party\brotli\libbrotlicommon.a'
) | ForEach-Object { Join-Path $build $_ }
$skcms = Get-ChildItem $build -Recurse -Filter 'libskcms*.a' | Select-Object -First 1
if ($skcms) { $libs += $skcms.FullName }

$exports = @('_dng_alloc', '_dng_free', '_dng_out_ptr', '_dng_out_size', '_dng_out_release',
  '_dng_jxl_version', '_dng_jxl_encode', '_dng_jxl_verify') -join ','
Invoke-Checked (Join-Path $emscripten 'em++.exe') (@(
    '-O3', '-msimd128', '-std=c++17',
    '-I', (Join-Path $libjxl 'lib\include'), '-I', (Join-Path $build 'lib\include'),
    (Join-Path $repo 'wasm\jxl_tile.cc')
  ) + $libs + @(
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createJxlModule',
    '-sENVIRONMENT=web,worker', '-sFILESYSTEM=0', '-sDYNAMIC_EXECUTION=0',
    '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=33554432', '-sSTACK_SIZE=1048576',
    "-sEXPORTED_FUNCTIONS=$exports", '-sEXPORTED_RUNTIME_METHODS=HEAPU8',
    '-sINCOMING_MODULE_JS_API=locateFile,wasmBinary,instantiateWasm,print,printErr',
    '-o', (Join-Path $outDir 'jxl_tile.mjs')
  ))

Get-ChildItem $outDir -Filter 'jxl_tile.*' | Select-Object Name, Length
