// Pure coordinate mapping between the rendered screenshot and Mirroir's
// coordinate space (macOS points relative to the iPhone Mirroring window's
// top-left corner).
//
//   imagePx = (pointer - imageContentOffset) * (naturalWidth / renderedContentWidth)
//   pt      = imagePx / pxPerPt
//
// `rect` is the image element's getBoundingClientRect(), so CSS scaling,
// transforms and zoom are already included. With `object-fit: contain` the
// bitmap is letterboxed (centred) inside that box; the offset is removed first.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ContentBox {
  /** Offset of the drawn bitmap inside the element box. */
  offsetX: number;
  offsetY: number;
  /** Size of the drawn bitmap in CSS pixels. */
  width: number;
  height: number;
}

export type ObjectFit = 'contain' | 'fill';

export interface WindowPoint {
  x: number;
  y: number;
}

export interface PointerMapInput {
  clientX: number;
  clientY: number;
  /** Bounding rect of the <img> element. */
  rect: Rect;
  /** Intrinsic bitmap size (img.naturalWidth/naturalHeight). */
  natural: Size;
  /** Pixels per window point for this frame (FrameMeta.pxPerPt). */
  pxPerPt: number;
  /** Window size in points; when given, results are clamped to it (Mirroir's bounds are inclusive). */
  windowPt?: Size | null;
  objectFit?: ObjectFit;
  /**
   * Out-of-image positions return null by default. With `clamp`, they snap to
   * the nearest edge (used for the end point of a swipe that leaves the image).
   */
  clamp?: boolean;
  /** Decimal places kept in the result (default 1). */
  precision?: number;
}

/** Where the bitmap is drawn inside an element box for the given object-fit. */
export function contentBox(rect: Size, natural: Size, fit: ObjectFit = 'contain'): ContentBox | null {
  if (!(rect.width > 0 && rect.height > 0 && natural.width > 0 && natural.height > 0)) return null;
  if (fit === 'fill') return { offsetX: 0, offsetY: 0, width: rect.width, height: rect.height };
  const scale = Math.min(rect.width / natural.width, rect.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { offsetX: (rect.width - width) / 2, offsetY: (rect.height - height) / 2, width, height };
}

export function roundTo(value: number, precision: number): number {
  const factor = 10 ** Math.max(0, Math.min(6, Math.trunc(precision)));
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Maps a pointer position (client coordinates) to Mirroir window points.
 * Returns null when the position is outside the drawn image (unless `clamp`)
 * or when the inputs cannot produce a valid mapping.
 */
export function pointerToWindowPoint(input: PointerMapInput): WindowPoint | null {
  const { rect, natural, pxPerPt } = input;
  if (!(pxPerPt > 0) || !Number.isFinite(pxPerPt)) return null;
  if (!Number.isFinite(input.clientX) || !Number.isFinite(input.clientY)) return null;
  const box = contentBox(rect, natural, input.objectFit ?? 'contain');
  if (!box) return null;

  let localX = input.clientX - rect.left - box.offsetX;
  let localY = input.clientY - rect.top - box.offsetY;
  const outside = localX < 0 || localY < 0 || localX > box.width || localY > box.height;
  if (outside) {
    if (!input.clamp) return null;
    localX = clampNumber(localX, 0, box.width);
    localY = clampNumber(localY, 0, box.height);
  }

  const imagePxX = localX * (natural.width / box.width);
  const imagePxY = localY * (natural.height / box.height);
  let x = imagePxX / pxPerPt;
  let y = imagePxY / pxPerPt;

  const windowPt = input.windowPt;
  if (windowPt && windowPt.width > 0 && windowPt.height > 0) {
    x = clampNumber(x, 0, windowPt.width);
    y = clampNumber(y, 0, windowPt.height);
  }
  const precision = input.precision ?? 1;
  return { x: roundTo(x, precision), y: roundTo(y, precision) };
}

/** Inverse mapping: window point → position inside the element box (CSS px), e.g. for drawing markers. */
export function windowPointToElement(point: WindowPoint, rect: Size, natural: Size, pxPerPt: number, fit: ObjectFit = 'contain'): { x: number; y: number } | null {
  const box = contentBox(rect, natural, fit);
  if (!box || !(pxPerPt > 0)) return null;
  const imagePxX = point.x * pxPerPt;
  const imagePxY = point.y * pxPerPt;
  return {
    x: box.offsetX + imagePxX * (box.width / natural.width),
    y: box.offsetY + imagePxY * (box.height / natural.height),
  };
}

/** Euclidean distance in CSS pixels. */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Largest box with the given aspect ratio that fits inside `available`. */
export function fitAspect(available: Size, aspect: number): Size {
  if (!(available.width > 0 && available.height > 0 && aspect > 0)) return { width: 0, height: 0 };
  const byWidth = { width: available.width, height: available.width / aspect };
  if (byWidth.height <= available.height) return byWidth;
  return { width: available.height * aspect, height: available.height };
}

export type GestureKind = 'tap' | 'drag';

/** Movement beyond this many CSS pixels turns a press into a drag. */
export const GESTURE_MOVE_THRESHOLD_PX = 8;

/**
 * Classifies a pointer gesture from its CSS-pixel travel. Every moved press is
 * a (finger-like) drag, whatever its speed: see lib/gestures.ts.
 */
export function classifyGesture(travelPx: number): GestureKind {
  return travelPx <= GESTURE_MOVE_THRESHOLD_PX ? 'tap' : 'drag';
}
