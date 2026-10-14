// Draws live ScreenCaptureKit frames straight onto a canvas as they arrive —
// no React render per frame. The canvas' intrinsic size is the frame's pixel
// size, so `object-fit: contain` and the touch mapping (lib/geometry.ts) treat
// it exactly like the screenshot <img>.

import { useLayoutEffect, type RefObject } from 'react';

import { liveScreen, type LiveFrame } from '../../lib/live-screen';

export interface LiveCanvasProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Accessible name while this is the picture being shown. */
  label: string;
  /** Hidden behind the polled screenshot (kept mounted so switching back is instant). */
  hidden: boolean;
  className?: string;
}

export function LiveCanvas({ canvasRef, label, hidden, className }: LiveCanvasProps) {
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    const draw = (frame: LiveFrame | null) => {
      if (!frame) return;
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      ctx ??= canvas.getContext('2d', { alpha: false });
      ctx?.drawImage(frame.image, 0, 0, frame.width, frame.height);
    };
    draw(liveScreen.getFrame());
    return liveScreen.subscribeFrames(draw);
  }, [canvasRef]);

  return (
    <canvas
      ref={canvasRef}
      role={hidden ? undefined : 'img'}
      aria-label={hidden ? undefined : label}
      aria-hidden={hidden || undefined}
      data-live-canvas=""
      className={className}
    />
  );
}
