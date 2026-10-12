/**
 * segmentation.geometry.ts — Pure geometry for the mocked SAM3 segmentation.
 *
 * No I/O, no Express, no DB: everything here is deterministic given a seed, so
 * it is covered by `tests/unit` like `instances-util.ts`.
 *
 * The outline is built in polar coordinates around a centre: a base radius
 * modulated by low-frequency sinusoids with random phase. That construction
 * yields, by definition, a single connected closed region with no holes —
 * there is exactly one radius per angle, so the polygon cannot self-intersect.
 * The explicit simplicity check stays as a guard against future changes to the
 * generator.
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface ShapeOptions {
  /** Image width in pixels (DICOM Columns). */
  columns: number;
  /** Image height in pixels (DICOM Rows). */
  rows: number;
  /** Seed — the same seed always produces the same outline. */
  seed: number;
  /** Polar vertices before smoothing (64-128). */
  points?: number;
  /** Chaikin smoothing passes over the closed polygon. */
  smoothingPasses?: number;
}

export interface GeneratedShape {
  contour: Point2D[];
  /** Run-length encoded mask, row-major, starting with a run of zeros. */
  maskRle: number[];
  /** Number of pixels inside the mask. */
  pixelCount: number;
  centre: Point2D;
  baseRadius: number;
}

// ── Deterministic PRNG ───────────────────────────────────────────────────────

/** mulberry32 — fast, well-distributed, non-cryptographic. Returns [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

// ── Polar outline ────────────────────────────────────────────────────────────

/**
 * Raw polygon: N points around a centre, base radius plus smooth low-frequency
 * noise (sum of three harmonics with random phase and weight).
 */
export function generatePolarContour(
  options: ShapeOptions,
  rng: () => number,
): { contour: Point2D[]; centre: Point2D; baseRadius: number } {
  const { columns, rows } = options;
  const pointCount = Math.max(16, Math.round(options.points ?? 96));
  const minSide = Math.min(columns, rows);

  // Centre inside the central region of the image (30 %-70 %).
  const centre: Point2D = {
    x: between(rng, columns * 0.3, columns * 0.7),
    y: between(rng, rows * 0.3, rows * 0.7),
  };

  // Base radius: 10 %-25 % of the shorter side.
  let baseRadius = between(rng, minSide * 0.1, minSide * 0.25);

  // Clamp so the figure fits entirely inside the image even at maximum noise
  // amplitude (25 % of the base radius), leaving a 2 px margin.
  const margin = 2;
  const distanceToEdge = Math.min(
    centre.x - margin,
    centre.y - margin,
    columns - margin - centre.x,
    rows - margin - centre.y,
  );
  const maxRadius = distanceToEdge / 1.25;
  if (maxRadius > 0 && baseRadius > maxRadius) baseRadius = maxRadius;

  const harmonics = [2, 3, 5].map((base) => ({
    frequency: base + Math.round(between(rng, 0, 1)),
    phase: between(rng, 0, Math.PI * 2),
    weight: between(rng, 0.3, 1),
  }));
  const totalWeight = harmonics.reduce((acc, h) => acc + h.weight, 0) || 1;
  const maxAmplitude = 0.25; // 25 % of the base radius

  const contour: Point2D[] = [];
  for (let i = 0; i < pointCount; i++) {
    const theta = (i / pointCount) * Math.PI * 2;
    let noise = 0;
    for (const h of harmonics) {
      noise += (h.weight / totalWeight) * Math.sin(h.frequency * theta + h.phase);
    }
    const radius = baseRadius * (1 + maxAmplitude * noise);
    contour.push({
      x: centre.x + Math.cos(theta) * radius,
      y: centre.y + Math.sin(theta) * radius,
    });
  }

  return { contour, centre, baseRadius };
}

// ── Smoothing ────────────────────────────────────────────────────────────────

/**
 * Chaikin on a closed polygon: each edge is replaced by points at 25 % and
 * 75 %. It converges to a quadratic B-spline, so the result reads as an organ
 * rather than a polygon, and it never introduces new self-intersections in an
 * already simple polygon.
 */
export function chaikinSmoothClosed(points: Point2D[], passes = 2): Point2D[] {
  let current = points;
  for (let pass = 0; pass < passes; pass++) {
    const n = current.length;
    if (n < 3) return current;
    const next: Point2D[] = [];
    for (let i = 0; i < n; i++) {
      const p = current[i];
      const q = current[(i + 1) % n];
      next.push({ x: 0.75 * p.x + 0.25 * q.x, y: 0.75 * p.y + 0.25 * q.y });
      next.push({ x: 0.25 * p.x + 0.75 * q.x, y: 0.25 * p.y + 0.75 * q.y });
    }
    current = next;
  }
  return current;
}

// ── Geometric validation ─────────────────────────────────────────────────────

function cross(p: Point2D, q: Point2D, r: Point2D): number {
  return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/** True when the closed polygon does not self-intersect. */
export function isSimplePolygon(points: Point2D[]): boolean {
  const n = points.length;
  if (n < 4) return true;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent edges — they legitimately share a vertex.
      if ((j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsIntersect(a, b, points[j], points[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** True when every vertex falls inside [0, columns] x [0, rows]. */
export function isInsideBounds(
  points: Point2D[],
  columns: number,
  rows: number,
): boolean {
  return points.every((p) => p.x >= 0 && p.y >= 0 && p.x <= columns && p.y <= rows);
}

// ── Rasterization ────────────────────────────────────────────────────────────

/**
 * Rasterize the polygon into a Rows x Columns mask by scanline sweep
 * (even-odd rule evaluated at pixel centres), returned run-length encoded so
 * a 512x512 mask travels as a few hundred numbers instead of 262 144.
 *
 * Encoding: alternating run lengths, row-major, starting with a run of zeros
 * (which may be 0-length). The runs always sum to columns * rows.
 */
export function rasterizePolygon(
  points: Point2D[],
  columns: number,
  rows: number,
): { maskRle: number[]; pixelCount: number } {
  const total = columns * rows;
  if (points.length < 3 || columns <= 0 || rows <= 0) {
    return { maskRle: total > 0 ? [total] : [], pixelCount: 0 };
  }

  const mask = new Uint8Array(total);
  let pixelCount = 0;
  const n = points.length;
  const crossings: number[] = [];

  for (let y = 0; y < rows; y++) {
    const scanY = y + 0.5;
    crossings.length = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if ((a.y <= scanY && b.y > scanY) || (b.y <= scanY && a.y > scanY)) {
        const t = (scanY - a.y) / (b.y - a.y);
        crossings.push(a.x + t * (b.x - a.x));
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - 0.5));
      const to = Math.min(columns - 1, Math.floor(crossings[k + 1] - 0.5));
      for (let x = from; x <= to; x++) {
        const idx = y * columns + x;
        if (mask[idx] === 0) {
          mask[idx] = 1;
          pixelCount++;
        }
      }
    }
  }

  return { maskRle: encodeRle(mask), pixelCount };
}

/** Run-length encode a 0/1 mask, starting with the count of leading zeros. */
export function encodeRle(mask: Uint8Array): number[] {
  const runs: number[] = [];
  let expected = 0;
  let run = 0;
  for (let i = 0; i < mask.length; i++) {
    const value = mask[i] ? 1 : 0;
    if (value === expected) {
      run++;
    } else {
      runs.push(run);
      expected = value;
      run = 1;
    }
  }
  runs.push(run);
  return runs;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Generate a reproducible pseudo-anatomical shape from a seed. Retries with
 * seed variants if the figure comes out degenerate (out of bounds,
 * self-intersecting, or of negligible area).
 */
export function generateSegmentationShape(options: ShapeOptions): GeneratedShape {
  const { columns, rows } = options;
  const passes = options.smoothingPasses ?? 2;

  for (let attempt = 0; attempt < 8; attempt++) {
    const rng = createRng(options.seed + attempt * 7919);
    const raw = generatePolarContour(options, rng);
    const contour = chaikinSmoothClosed(raw.contour, passes);

    if (!isInsideBounds(contour, columns, rows)) continue;
    if (!isSimplePolygon(contour)) continue;

    const { maskRle, pixelCount } = rasterizePolygon(contour, columns, rows);
    if (pixelCount < 16) continue;

    return {
      contour,
      maskRle,
      pixelCount,
      centre: raw.centre,
      baseRadius: raw.baseRadius,
    };
  }

  // Deterministic fallback: a centred circle at 15 % of the shorter side.
  // Only reachable for tiny or degenerate images.
  const centre = { x: columns / 2, y: rows / 2 };
  const baseRadius = Math.max(2, Math.min(columns, rows) * 0.15);
  const contour: Point2D[] = [];
  for (let i = 0; i < 64; i++) {
    const theta = (i / 64) * Math.PI * 2;
    contour.push({
      x: centre.x + Math.cos(theta) * baseRadius,
      y: centre.y + Math.sin(theta) * baseRadius,
    });
  }
  const { maskRle, pixelCount } = rasterizePolygon(contour, columns, rows);
  return { contour, maskRle, pixelCount, centre, baseRadius };
}
