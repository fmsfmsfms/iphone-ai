// Throttled screenshot polling for the live viewer.
//
// This is NOT video: each frame is one Mirroir `screenshot` call. The stream
// runs only while a viewer is visible, Screen Recording is confirmed and
// Mirroring is connected; it drops to an idle rate after inactivity and backs
// off on errors. Measured FPS and latency are reported honestly.

import type { StreamStats } from '@iphone-ai/shared';

import type { EventHub } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import type { SettingsStore } from '../core/settings-store.js';
import { DeviceError, type DeviceController } from './device-controller.js';

interface ViewerState {
  visible: boolean;
  interactive: boolean;
}

export class ScreenStream {
  private readonly viewers = new Map<string, ViewerState>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastActivityAt = Date.now();
  private boostUntil = 0;
  private readonly frameTimes: number[] = [];
  private readonly latencies: number[] = [];
  private consecutiveErrors = 0;
  private lastError: string | null = null;
  private pausedReason: string | null = null;
  private lastFrameAt: number | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private readonly log: Logger;
  private stopped = false;

  constructor(
    private readonly device: DeviceController,
    private readonly settings: SettingsStore,
    private readonly hub: EventHub,
    log: Logger,
  ) {
    this.log = log.child('stream');
    device.on('frame', () => {
      this.lastFrameAt = Date.now();
    });
    device.on('action', () => this.markActivity(4000));
    device.on('mirroring', () => this.schedule(200));
    device.on('permissions', () => this.schedule(200));
  }

  start(): void {
    this.stopped = false;
    this.statsTimer = setInterval(() => this.publishStats(), 2000);
    this.statsTimer.unref();
    this.schedule(500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.timer = null;
  }

  setViewer(id: string, state: ViewerState | null): void {
    if (state) this.viewers.set(id, state);
    else this.viewers.delete(id);
    if (state?.visible) this.markActivity();
    this.schedule(100);
  }

  /** User or AI activity: run at the active rate (optionally boosted briefly after actions). */
  markActivity(boostMs = 0): void {
    this.lastActivityAt = Date.now();
    if (boostMs > 0) this.boostUntil = Date.now() + boostMs;
    this.schedule(150);
  }

  private visibleViewers(): number {
    let n = 0;
    for (const v of this.viewers.values()) if (v.visible) n += 1;
    return n;
  }

  /** Target FPS for the current situation, or 0 when polling should pause. */
  private targetFps(): { fps: number; reason: string | null } {
    const cfg = this.settings.get().connection.screenshot;
    const status = this.device.getStatus();
    if (status.server.state !== 'ready') return { fps: 0, reason: 'Mirroir MCP server is not ready' };
    if (status.permissions.screenRecording !== 'granted') {
      return { fps: 0, reason: 'Screen Recording permission not confirmed' };
    }
    if (status.mirroring.state === 'paused') return { fps: 0, reason: 'iPhone Mirroring is paused' };
    if (status.mirroring.state !== 'connected') return { fps: 0, reason: 'iPhone Mirroring is not connected' };
    if (cfg.pauseWhenHidden && this.visibleViewers() === 0 && status.controlOwner === 'none') {
      return { fps: 0, reason: 'No visible viewer' };
    }
    const now = Date.now();
    const active = status.controlOwner !== 'none' || now - this.lastActivityAt < cfg.idleAfterMs;
    let fps = active ? cfg.activeFps : cfg.idleFps;
    if (now < this.boostUntil) fps = Math.max(fps, Math.min(4, cfg.activeFps * 2));
    if (fps <= 0) return { fps: 0, reason: 'Idle' };
    return { fps, reason: null };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped || this.running) return;
    const { fps, reason } = this.targetFps();
    if (fps <= 0) {
      if (this.pausedReason !== reason) {
        this.pausedReason = reason;
        this.publishStats();
      }
      // Re-evaluate periodically; state changes also reschedule.
      this.schedule(2000);
      return;
    }
    this.pausedReason = null;
    this.running = true;
    const started = Date.now();
    try {
      const frame = await this.device.captureFrame({ reason: 'live-viewer' });
      this.frameTimes.push(Date.now());
      this.latencies.push(frame.meta.latencyMs);
      this.trim();
      this.consecutiveErrors = 0;
      this.lastError = null;
    } catch (err) {
      this.consecutiveErrors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      if (!(err instanceof DeviceError)) this.log.warn('Live frame failed', { error: this.lastError });
    } finally {
      this.running = false;
    }
    const interval = 1000 / fps;
    const elapsed = Date.now() - started;
    const backoff = this.consecutiveErrors > 0 ? Math.min(15000, 1000 * 2 ** Math.min(this.consecutiveErrors, 4)) : 0;
    this.schedule(Math.max(50, interval - elapsed) + backoff);
  }

  private trim(): void {
    const cutoff = Date.now() - 10000;
    while (this.frameTimes.length && this.frameTimes[0]! < cutoff) this.frameTimes.shift();
    while (this.latencies.length > 30) this.latencies.shift();
  }

  stats(): StreamStats {
    this.trim();
    const { fps } = this.targetFps();
    const windowSec = this.frameTimes.length > 1 ? (Date.now() - this.frameTimes[0]!) / 1000 : 10;
    const measuredFps = this.frameTimes.length > 1 ? (this.frameTimes.length - 1) / Math.max(windowSec, 1) : 0;
    const avgLatencyMs = this.latencies.length
      ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length)
      : 0;
    return {
      mode: 'polling-screenshots',
      running: fps > 0,
      targetFps: fps,
      measuredFps: Math.round(measuredFps * 100) / 100,
      avgLatencyMs,
      lastFrameAt: this.lastFrameAt,
      pausedReason: this.pausedReason,
      viewers: this.visibleViewers(),
      consecutiveErrors: this.consecutiveErrors,
      lastError: this.lastError,
    };
  }

  private publishStats(): void {
    this.hub.publish({ type: 'stream_stats', stats: this.stats() });
  }
}
