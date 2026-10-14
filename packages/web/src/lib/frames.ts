// Shared screenshot loader. Every `frame` event announces a new polled
// screenshot; while at least one PhoneViewer is mounted the image is fetched
// once, decoded off-screen and published here, so all viewers (dashboard
// preview, live viewer, enlarged modal) swap to it without flicker.

import { useSyncExternalStore } from 'react';

import type { FrameMeta } from '@iphone-ai/shared';

import { appStore } from '../state/store';
import { api, fetchBlob } from './api';

export interface LoadedFrame {
  /** Object URL of the PNG (kept alive while it may still be displayed). */
  url: string;
  /** Sequence number reported by the backend for this image. */
  seq: number;
  /** Metadata announced for this frame; null if the image arrived without a matching announcement. */
  meta: FrameMeta | null;
  naturalWidth: number;
  naturalHeight: number;
  loadedAt: number;
  blob: Blob;
}

const KEEP_URLS = 4;

let current: LoadedFrame | null = null;
let loadError: string | null = null;
const listeners = new Set<() => void>();
const liveUrls: string[] = [];
let inFlight: { seq: number; controller: AbortController } | null = null;
/** Next frame to load once the in-flight fetch ends: a seq, `null` for "latest", undefined for none. */
let pending: { seq: number | null } | undefined;
/** Set when the backend's frame sequence restarted (backend relaunch): accept lower sequence numbers once. */
let sequenceReset = false;

function isNewer(seq: number): boolean {
  return !current || sequenceReset || seq > current.seq;
}

function publish(): void {
  for (const listener of [...listeners]) listener();
}

function retain(url: string): void {
  liveUrls.push(url);
  while (liveUrls.length > KEEP_URLS) {
    const old = liveUrls.shift();
    if (old) URL.revokeObjectURL(old);
  }
}

async function decode(url: string): Promise<{ width: number; height: number }> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    await new Promise<void>((resolve, reject) => {
      if (img.complete && img.naturalWidth > 0) return resolve();
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The screenshot could not be decoded.'));
    });
  }
  return { width: img.naturalWidth, height: img.naturalHeight };
}

async function load(seq: number | null): Promise<void> {
  const controller = new AbortController();
  inFlight = { seq: seq ?? -1, controller };
  try {
    const { blob, headers } = await fetchBlob(api.screen.latestFrameUrl(seq ?? undefined), { signal: controller.signal });
    const headerSeq = Number(headers.get('x-frame-seq'));
    const actualSeq = Number.isFinite(headerSeq) && headerSeq > 0 ? headerSeq : (seq ?? appStore.getState().frame?.seq ?? 0);
    if (!isNewer(actualSeq)) return;
    const url = URL.createObjectURL(blob);
    let size: { width: number; height: number };
    try {
      size = await decode(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    if (controller.signal.aborted) {
      URL.revokeObjectURL(url);
      return;
    }
    if (!isNewer(actualSeq)) {
      URL.revokeObjectURL(url);
      return;
    }
    const announced = appStore.getState().frame;
    const meta = announced && announced.seq === actualSeq ? announced : null;
    retain(url);
    sequenceReset = false;
    current = { url, seq: actualSeq, meta, naturalWidth: size.width, naturalHeight: size.height, loadedAt: Date.now(), blob };
    loadError = null;
    publish();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    // 404 simply means "no frame yet"; keep showing what we have.
    const status = (err as { status?: number }).status;
    if (status !== 404) {
      loadError = err instanceof Error ? err.message : 'The screenshot could not be loaded.';
      publish();
    }
  } finally {
    if (inFlight?.controller === controller) inFlight = null;
    if (pending) {
      const next = pending.seq;
      pending = undefined;
      if (next === null || isNewer(next)) void load(next);
    }
  }
}

/** Requests the frame with this sequence number (coalesces bursts: at most one fetch in flight). */
export function requestFrame(seq: number | null): void {
  if (seq !== null && !isNewer(seq)) return;
  if (inFlight) {
    pending = { seq };
    return;
  }
  void load(seq);
}

/** Attaches meta to the current frame when its announcement arrives after the image. */
function attachMeta(meta: FrameMeta): void {
  if (current && current.seq === meta.seq && !current.meta) {
    current = { ...current, meta };
    publish();
  }
}

let started = false;
let lastSeenSeq = -1;
let lastViewers = 0;

/** Wires the loader to the store (idempotent). */
export function startFrameLoader(): void {
  if (started) return;
  started = true;
  appStore.subscribe(() => {
    const state = appStore.getState();
    const viewers = state.ui.viewers;
    const meta = state.frame;
    const becameVisible = viewers > 0 && lastViewers === 0;
    lastViewers = viewers;
    if (viewers === 0) return;
    if (meta && meta.seq !== lastSeenSeq) {
      // The store only accepts a lower seq when it was captured later (backend restarted).
      if (meta.seq < lastSeenSeq) sequenceReset = true;
      lastSeenSeq = meta.seq;
      attachMeta(meta);
      requestFrame(meta.seq);
    } else if (becameVisible && !current) {
      // First viewer mounted: show the last captured frame, if any, right away.
      requestFrame(meta?.seq ?? null);
    }
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLatestFrame(): LoadedFrame | null {
  return current;
}

export function useLatestFrame(): LoadedFrame | null {
  return useSyncExternalStore(subscribe, getLatestFrame, getLatestFrame);
}

export function useFrameLoadError(): string | null {
  return useSyncExternalStore(subscribe, () => loadError, () => null);
}
