/** DNG Squeeze: page logic (file queue, progress, saving, offline support). */

import "./styles.css";
import { compressDng, planFile } from "./compress.ts";
import { EngineError, loadEngine, unsupportedReason } from "./engine.ts";
import { DngError, type DngPlan } from "./lib/dng.ts";
import { formatBytes, formatChange, formatDuration, formatEta } from "./lib/format.ts";
import { createThumbnail } from "./thumbnail.ts";
import { TilePool } from "./worker/pool.ts";

type State = "reading" | "queued" | "working" | "done" | "skipped" | "error";

const PARTS = ["thumb", "name", "remove", "meta", "progress", "bar", "result", "sizes", "change", "note", "retry", "save"] as const;
type Part = (typeof PARTS)[number];

interface Item {
  readonly file: File;
  /** Identifies the same file picked twice. */
  readonly key: string;
  readonly root: HTMLLIElement;
  readonly parts: Readonly<Record<Part, HTMLElement>>;
  state: State;
  plan: DngPlan | null;
  output: File | null;
  message: string;
  retryable: boolean;
  /** Fraction of tiles done while working. */
  progress: number;
  startedAt: number;
  elapsedMs: number;
  saved: boolean;
  removed: boolean;
  controller: AbortController;
}

const EFFORT_KEY = "dng-squeeze:effort";
const DEFAULT_TITLE = document.title;
const THUMBNAIL_CSS_PX = 72;
/** Above this much compressed output held in memory, suggest saving and clearing. */
const MEMORY_HINT_BYTES = 1e9;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

const fileInput = byId<HTMLInputElement>("file-input");
const dropzoneHint = byId("dropzone-hint");
const notice = byId("notice");
const queueSection = byId("queue");
const queueHint = byId("queue-hint");
const cardList = byId<HTMLUListElement>("cards");
const memoryHint = byId("memory-hint");
const summaryText = byId("summary-text");
const saveAllButton = byId<HTMLButtonElement>("save-all");
const clearButton = byId<HTMLButtonElement>("clear");
const dropOverlay = byId("drop-overlay");
const announcer = byId("announcer");
const installButton = byId<HTMLButtonElement>("install");
const offlinePill = byId("offline-ready");
const updateToast = byId("update");
const updateButton = byId<HTMLButtonElement>("update-reload");
const cardTemplate = byId<HTMLTemplateElement>("card-template");
const effortInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="effort"]')];

const touchDevice = matchMedia("(pointer: coarse)").matches;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const items: Item[] = [];
let pool: TilePool | null = null;
let analyzing = false;
let compressing = false;
/** The notice currently shows a (possibly temporary) engine problem. */
let engineNotice = false;

// ---------------------------------------------------------------------------
// Small helpers

function showNotice(message: string): void {
  notice.textContent = message;
  notice.hidden = false;
}

function announce(message: string): void {
  announcer.textContent = "";
  requestAnimationFrame(() => {
    announcer.textContent = message;
  });
}

function currentEffort(): number {
  return Number(effortInputs.find((input) => input.checked)?.value ?? 5);
}

function isActive(item: Item): boolean {
  return item.state === "reading" || item.state === "queued" || item.state === "working";
}

function describeError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof DngError) return { message: error.message, retryable: false };
  if (error instanceof EngineError) return { message: error.message, retryable: !error.unsupported };
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotReadableError" || name === "NotFoundError") {
    return {
      message: "Couldn’t read this file. If it’s stored in iCloud, download it to your device first, then try again.",
      retryable: true,
    };
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/out of memory|allocation failed/i.test(text)) {
    return { message: "Ran out of memory. Close other apps or tabs, then try again.", retryable: true };
  }
  return { message: `Couldn’t compress this photo (${text}). Your original is untouched.`, retryable: true };
}

// ---------------------------------------------------------------------------
// Cards

function createCard(file: File): Pick<Item, "root" | "parts"> {
  const root = (cardTemplate.content.firstElementChild as HTMLLIElement).cloneNode(true) as HTMLLIElement;
  const found: Partial<Record<Part, HTMLElement>> = {};
  for (const element of root.querySelectorAll<HTMLElement>("[data-part]")) {
    found[element.dataset.part as Part] = element;
  }
  for (const part of PARTS) if (!found[part]) throw new Error(`Card template is missing ${part}`);
  const parts = found as Record<Part, HTMLElement>;
  parts.name.textContent = file.name;
  parts.name.title = file.name;
  parts.remove.setAttribute("aria-label", `Remove ${file.name}`);
  parts.retry.setAttribute("aria-label", `Try ${file.name} again`);
  parts.progress.setAttribute("aria-label", `Compressing ${file.name}`);
  return { root, parts };
}

function describeMeta(item: Item): string {
  const size = formatBytes(item.file.size);
  const plan = item.plan;
  if (!plan) return size;
  const megapixels = (plan.image.width * plan.image.height) / 1e6;
  return `${plan.camera} · ${megapixels.toFixed(1)} MP · ${size}`;
}

function renderCard(item: Item): void {
  const { root, parts } = item;
  root.dataset.state = item.state;
  root.toggleAttribute("data-retry", item.state === "error" && item.retryable);
  root.toggleAttribute("data-saved", item.state === "done" && item.saved);
  parts.meta.textContent = describeMeta(item);
  let note = item.message;
  if (item.state === "reading") note = "Reading…";
  else if (item.state === "queued") note = "Waiting…";
  else if (item.state === "working") {
    const percent = Math.floor(item.progress * 100);
    parts.bar.style.transform = `scaleX(${item.progress})`;
    parts.progress.setAttribute("aria-valuenow", String(percent));
    const elapsed = performance.now() - item.startedAt;
    if (item.progress >= 0.05 && elapsed > 1500) {
      note = `${percent}% · ${formatEta((elapsed * (1 - item.progress)) / item.progress)}`;
    } else {
      note = percent > 0 ? `${percent}%` : "Starting…";
    }
  } else if (item.state === "done" && item.output) {
    const before = item.file.size;
    const after = item.output.size;
    parts.sizes.textContent = `${formatBytes(before)} → ${formatBytes(after)}`;
    parts.change.textContent = formatChange(before, after);
    root.toggleAttribute("data-bigger", after >= before);
    note =
      after < before
        ? `Verified lossless · ${formatDuration(item.elapsedMs)}`
        : "Lossless, but not smaller — keep your original.";
    parts.save.textContent = item.saved ? "Saved" : "Save";
    parts.save.setAttribute("aria-label", `${item.saved ? "Save again" : "Save"} ${item.output.name}`);
  }
  parts.note.textContent = note;
}

const dirty = new Set<Item>();
let frame = 0;

/** Batches progress updates into one render per animation frame. */
function scheduleRender(item: Item): void {
  dirty.add(item);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const entry of dirty) if (!entry.removed) renderCard(entry);
    dirty.clear();
    renderSummary();
  });
}

function renderSummary(): void {
  queueSection.hidden = items.length === 0;
  const done = items.filter((item) => item.state === "done" && item.output);
  const active = items.filter(isActive);
  const before = done.reduce((sum, item) => sum + item.file.size, 0);
  const after = done.reduce((sum, item) => sum + (item.output?.size ?? 0), 0);
  const saved = formatBytes(Math.max(0, before - after));

  if (active.length > 0) {
    const total = done.length + active.length;
    const position = Math.min(total, done.length + 1);
    summaryText.textContent =
      `Squeezing ${total === 1 ? "your photo" : `photo ${position} of ${total}`}` +
      (done.length > 0 ? ` · ${saved} saved so far` : "");
  } else if (done.length > 0) {
    summaryText.textContent =
      `${done.length === 1 ? "1 photo" : `${done.length} photos`} · ${formatBytes(before)} → ${formatBytes(after)} · ` +
      `${saved} saved (${formatChange(before, after)})`;
  } else {
    summaryText.textContent = "Nothing to save yet.";
  }
  saveAllButton.hidden = done.length < 2;
  saveAllButton.textContent = `Save all (${done.length})`;
  memoryHint.hidden = after < MEMORY_HINT_BYTES;

  const working = items.find((item) => item.state === "working");
  document.title = working ? `${Math.floor(working.progress * 100)}% · ${DEFAULT_TITLE}` : DEFAULT_TITLE;
  queueHint.hidden = !(compressing && touchDevice);
  setUnloadGuard(active.length > 0 || done.some((item) => !item.saved));
}

// ---------------------------------------------------------------------------
// Queue

function addFiles(files: Iterable<File>): void {
  const wasEmpty = items.length === 0;
  let added = 0;
  let duplicates = 0;
  for (const file of files) {
    const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
    if (items.some((item) => item.key === key && item.state !== "error")) {
      duplicates++;
      continue;
    }
    const item: Item = {
      file,
      key,
      ...createCard(file),
      state: "reading",
      plan: null,
      output: null,
      message: "",
      retryable: false,
      progress: 0,
      startedAt: 0,
      elapsedMs: 0,
      saved: false,
      removed: false,
      controller: new AbortController(),
    };
    item.parts.remove.addEventListener("click", () => removeItem(item, true));
    item.parts.retry.addEventListener("click", () => retryItem(item));
    item.parts.save.addEventListener("click", () => save([item]));
    items.push(item);
    cardList.append(item.root);
    renderCard(item);
    added++;
  }
  if (duplicates > 0) {
    announce(duplicates === 1 ? "That photo is already in the list." : `${duplicates} photos were already in the list.`);
  }
  if (added === 0) return;
  // Start fetching the compressor while the files are being read.
  loadEngine().catch(() => {});
  renderSummary();
  if (wasEmpty) {
    queueSection.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
  }
  void runAnalysis();
}

function removeItem(item: Item, moveFocus: boolean): void {
  item.removed = true;
  item.controller.abort();
  const index = items.indexOf(item);
  if (index >= 0) items.splice(index, 1);
  const hadFocus = item.root.contains(document.activeElement);
  item.root.remove();
  if (moveFocus && hadFocus) {
    const neighbour = items[index] ?? items[index - 1];
    (neighbour ? neighbour.parts.remove : fileInput).focus();
  }
  renderSummary();
}

function retryItem(item: Item): void {
  item.state = "reading";
  item.message = "";
  item.retryable = false;
  item.controller = new AbortController();
  renderCard(item);
  renderSummary();
  void runAnalysis();
}

function fail(item: Item, error: unknown): void {
  const { message, retryable } = describeError(error);
  item.state = "error";
  item.output = null;
  item.message = message;
  item.retryable = retryable;
  announce(`${item.file.name}: ${message}`);
}

let thumbnails: Promise<void> = Promise.resolve();

/** Thumbnails are made one at a time: each decodes a full-size preview JPEG. */
function queueThumbnail(item: Item, plan: DngPlan): void {
  const preview = plan.preview;
  if (!preview) return;
  thumbnails = thumbnails.then(async () => {
    if (item.removed) return;
    const size = Math.round(THUMBNAIL_CSS_PX * Math.min(Math.max(devicePixelRatio || 1, 1), 3));
    try {
      const canvas = await createThumbnail(item.file, preview, plan.orientation, size);
      if (canvas && !item.removed) {
        canvas.className = "thumb-image";
        item.parts.thumb.replaceChildren(canvas);
      }
    } catch {
      // The placeholder stays; thumbnails are a nicety.
    }
  });
}

async function runAnalysis(): Promise<void> {
  if (analyzing) return;
  analyzing = true;
  try {
    for (let item = items.find((i) => i.state === "reading"); item; item = items.find((i) => i.state === "reading")) {
      await analyze(item);
    }
  } finally {
    analyzing = false;
  }
}

async function analyze(item: Item): Promise<void> {
  try {
    const plan = await planFile(item.file);
    if (item.removed) return;
    item.plan = plan;
    item.state = "queued";
    if (!item.parts.thumb.querySelector("canvas")) queueThumbnail(item, plan);
  } catch (error) {
    if (item.removed) return;
    if (error instanceof DngError && error.code === "already-jxl") {
      item.state = "skipped";
      item.message = "Already compressed with JPEG XL — nothing to do.";
    } else {
      fail(item, error);
    }
  }
  renderCard(item);
  renderSummary();
  void runCompression();
}

async function runCompression(): Promise<void> {
  if (compressing) return;
  compressing = true;
  void syncWakeLock();
  try {
    for (let item = items.find((i) => i.state === "queued"); item; item = items.find((i) => i.state === "queued")) {
      await compress(item);
    }
  } finally {
    compressing = false;
    void syncWakeLock();
    renderSummary();
  }
}

async function compress(item: Item): Promise<void> {
  const plan = item.plan as DngPlan;
  const effort = currentEffort();
  item.state = "working";
  item.progress = 0;
  item.startedAt = performance.now();
  renderCard(item);
  renderSummary();
  try {
    pool ??= new TilePool(await loadEngine());
    const output = await compressDng(item.file, plan, pool, {
      effort,
      signal: item.controller.signal,
      onProgress: (done, total) => {
        item.progress = done / total;
        scheduleRender(item);
      },
    });
    if (item.removed) return;
    item.output = output;
    item.elapsedMs = performance.now() - item.startedAt;
    item.state = "done";
    if (engineNotice) {
      engineNotice = false;
      notice.hidden = true;
    }
    announce(
      `${item.file.name} is done: ${formatBytes(item.file.size)} to ${formatBytes(output.size)}, ` +
        `${formatChange(item.file.size, output.size)}.`,
    );
  } catch (error) {
    if (item.removed || item.controller.signal.aborted) return;
    fail(item, error);
    if (error instanceof EngineError) {
      // Every other photo would fail the same way.
      showNotice(error.message);
      engineNotice = true;
      for (const other of items) {
        if (other.state === "queued") {
          fail(other, error);
          renderCard(other);
        }
      }
    }
  }
  renderCard(item);
  renderSummary();
}

// ---------------------------------------------------------------------------
// Saving

function download(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Safari needs the URL for a while after the click.
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

function markSaved(targets: readonly Item[]): void {
  for (const item of targets) {
    item.saved = true;
    if (!item.removed) renderCard(item);
  }
  renderSummary();
}

function canShareFiles(files: File[]): boolean {
  try {
    return typeof navigator.share === "function" && (navigator.canShare?.({ files }) ?? false);
  } catch {
    return false;
  }
}

/** Phones get the share sheet (Save to Files, AirDrop…); computers get downloads. */
function save(targets: readonly Item[]): void {
  const ready = targets.filter((item): item is Item & { output: File } => item.output !== null);
  if (ready.length === 0) return;
  const files = ready.map((item) => item.output);
  if (touchDevice && canShareFiles(files)) {
    navigator.share({ files }).then(
      () => markSaved(ready),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        files.forEach(download);
        markSaved(ready);
      },
    );
    return;
  }
  // The first download keeps the click's user activation; the rest are spaced out.
  files.forEach((file, i) => (i === 0 ? download(file) : setTimeout(() => download(file), i * 400)));
  markSaved(ready);
}

// ---------------------------------------------------------------------------
// Keeping the device awake and the work safe

let wakeLock: WakeLockSentinel | null = null;
let wakeLockPending = false;

async function syncWakeLock(): Promise<void> {
  const wanted = compressing && document.visibilityState === "visible";
  if (wanted && !wakeLock && !wakeLockPending && "wakeLock" in navigator) {
    wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => {
        if (wakeLock === lock) wakeLock = null;
      });
      wakeLock = lock;
    } catch {
      // Not allowed right now (e.g. battery saver); the work continues anyway.
    } finally {
      wakeLockPending = false;
    }
    if (!(compressing && document.visibilityState === "visible")) void syncWakeLock();
  } else if (!wanted && wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    await lock.release().catch(() => {});
  }
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Older Chromium and Safari still look at returnValue.
  event.returnValue = "";
}

let unloadGuarded = false;

/** Only listens for unloads while needed, so the page stays eligible for the back/forward cache. */
function setUnloadGuard(on: boolean): void {
  if (on === unloadGuarded) return;
  unloadGuarded = on;
  if (on) addEventListener("beforeunload", onBeforeUnload);
  else removeEventListener("beforeunload", onBeforeUnload);
}

// ---------------------------------------------------------------------------
// Input: picker, drag and drop, paste

fileInput.addEventListener("change", () => {
  if (fileInput.files) addFiles([...fileInput.files]);
  fileInput.value = "";
});

const hasFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") ?? false;
let dragDepth = 0;

addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  if (event.dataTransfer) addFiles([...event.dataTransfer.files]);
});
addEventListener("paste", (event) => {
  const files = event.clipboardData?.files;
  if (!files || files.length === 0) return;
  event.preventDefault();
  addFiles([...files]);
});

saveAllButton.addEventListener("click", () => save(items.filter((item) => item.state === "done")));

clearButton.addEventListener("click", () => {
  const busy = items.some(isActive);
  const unsaved = items.some((item) => item.state === "done" && !item.saved);
  if (busy || unsaved) {
    const question = busy
      ? "Stop and clear the list? Photos still in progress won’t be compressed."
      : "Clear the list? Compressed photos you haven’t saved will be lost.";
    if (!confirm(question)) return;
  }
  for (const item of [...items]) removeItem(item, false);
  fileInput.focus();
});

for (const input of effortInputs) {
  input.addEventListener("change", () => {
    try {
      localStorage.setItem(EFFORT_KEY, String(currentEffort()));
    } catch {
      // Storage may be unavailable (private mode); the choice still applies.
    }
  });
}

document.addEventListener("visibilitychange", () => void syncWakeLock());

// ---------------------------------------------------------------------------
// Install and offline support

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

let installPrompt: BeforeInstallPromptEvent | null = null;

addEventListener("beforeinstallprompt", (event) => {
  installPrompt = event as BeforeInstallPromptEvent;
  installButton.hidden = false;
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  installButton.hidden = true;
});
installButton.addEventListener("click", () => {
  const prompt = installPrompt;
  installPrompt = null;
  installButton.hidden = true;
  prompt?.prompt().catch(() => {});
});

function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;
  let reloading = false;
  container.addEventListener("controllerchange", () => {
    if (reloading) location.reload();
  });
  const offerUpdate = (worker: ServiceWorker): void => {
    updateToast.hidden = false;
    updateButton.onclick = () => {
      reloading = true;
      updateButton.disabled = true;
      worker.postMessage("skip-waiting");
    };
  };
  container.register("./sw.js").then(
    (registration) => {
      if (registration.waiting && container.controller) offerUpdate(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed" && container.controller) offerUpdate(installing);
        });
      });
    },
    () => {
      // Offline support is optional; the app works without it.
    },
  );
  void container.ready.then(() => {
    offlinePill.hidden = false;
  });
}

// ---------------------------------------------------------------------------
// Start-up

interface LaunchQueue {
  setConsumer(consumer: (params: { readonly files: readonly FileSystemHandle[] }) => void): void;
}

// Installed on a computer, the app can be picked in "Open with" for .dng files.
const { launchQueue } = window as Window & { launchQueue?: LaunchQueue };
launchQueue?.setConsumer(({ files }) => {
  const handles = files.filter((handle): handle is FileSystemFileHandle => handle.kind === "file");
  if (handles.length === 0) return;
  Promise.all(handles.map((handle) => handle.getFile())).then(addFiles, () => {
    showNotice("Couldn’t open those files. Try choosing them with the button instead.");
  });
});

try {
  const savedEffort = localStorage.getItem(EFFORT_KEY);
  const match = effortInputs.find((input) => input.value === savedEffort);
  if (match) match.checked = true;
} catch {
  // Keep the default.
}
if (touchDevice) dropzoneHint.textContent = "Pick them from the Files app";
const unsupported = unsupportedReason();
if (unsupported) showNotice(unsupported);
if (document.readyState === "complete") registerServiceWorker();
else addEventListener("load", registerServiceWorker, { once: true });
