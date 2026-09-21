/**
 * Unit tests for segmentation.geometry — the mocked SAM3 outline generator.
 * Pure logic, no I/O, runs under jest (npm run test:unit).
 */
import {
  createRng,
  generateSegmentationShape,
  isSimplePolygon,
  isInsideBounds,
  rasterizePolygon,
  encodeRle,
  type Point2D,
} from "../../../src/modules/segmentation/segmentation.geometry";

const COLUMNS = 512;
const ROWS = 512;

function decodeRle(rle: number[], total: number): Uint8Array {
  const mask = new Uint8Array(total);
  let idx = 0;
  let value = 0;
  for (const run of rle) {
    if (value === 1) mask.fill(1, idx, idx + run);
    idx += run;
    value = value ? 0 : 1;
  }
  return mask;
}

/** Flood fill from the mask's set pixels — counts 4-connected components. */
function countComponents(mask: Uint8Array, columns: number, rows: number): number {
  const seen = new Uint8Array(mask.length);
  let components = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    components++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % columns;
      const y = (idx - x) / columns;
      const neighbours = [
        x > 0 ? idx - 1 : -1,
        x < columns - 1 ? idx + 1 : -1,
        y > 0 ? idx - columns : -1,
        y < rows - 1 ? idx + columns : -1,
      ];
      for (const n of neighbours) {
        if (n >= 0 && mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
  }
  return components;
}

describe("createRng", () => {
  it("is deterministic for a given seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("stays within [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("encodeRle", () => {
  it("starts with the count of leading zeros", () => {
    expect(encodeRle(Uint8Array.from([0, 0, 1, 1, 0]))).toEqual([2, 2, 1]);
  });

  it("emits a leading zero-length run when the mask starts set", () => {
    expect(encodeRle(Uint8Array.from([1, 1, 0]))).toEqual([0, 2, 1]);
  });

  it("round-trips through decode", () => {
    const mask = Uint8Array.from([0, 1, 1, 0, 0, 1]);
    expect(Array.from(decodeRle(encodeRle(mask), mask.length))).toEqual(
      Array.from(mask),
    );
  });
});

describe("rasterizePolygon", () => {
  it("fills a square's interior", () => {
    const square: Point2D[] = [
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 8, y: 8 },
      { x: 2, y: 8 },
    ];
    const { maskRle, pixelCount } = rasterizePolygon(square, 10, 10);
    expect(pixelCount).toBe(36); // pixel centres 2.5..7.5 on both axes
    const mask = decodeRle(maskRle, 100);
    expect(mask[5 * 10 + 5]).toBe(1);
    expect(mask[0]).toBe(0);
  });

  it("returns an empty mask for a degenerate polygon", () => {
    const { maskRle, pixelCount } = rasterizePolygon([{ x: 1, y: 1 }], 4, 4);
    expect(pixelCount).toBe(0);
    expect(maskRle).toEqual([16]);
  });
});

describe("generateSegmentationShape", () => {
  it("is reproducible for a given seed", () => {
    const a = generateSegmentationShape({ columns: COLUMNS, rows: ROWS, seed: 123 });
    const b = generateSegmentationShape({ columns: COLUMNS, rows: ROWS, seed: 123 });
    expect(a.contour).toEqual(b.contour);
    expect(a.maskRle).toEqual(b.maskRle);
  });

  it("produces a different shape for a different seed", () => {
    const a = generateSegmentationShape({ columns: COLUMNS, rows: ROWS, seed: 1 });
    const b = generateSegmentationShape({ columns: COLUMNS, rows: ROWS, seed: 2 });
    expect(a.contour).not.toEqual(b.contour);
  });

  it("stays inside the image and never self-intersects, over many seeds", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const shape = generateSegmentationShape({ columns: COLUMNS, rows: ROWS, seed });
      expect(isInsideBounds(shape.contour, COLUMNS, ROWS)).toBe(true);
      expect(isSimplePolygon(shape.contour)).toBe(true);
    }
  });

  it("centres the shape in the central region of the image", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { centre } = generateSegmentationShape({
        columns: COLUMNS,
        rows: ROWS,
        seed,
      });
      expect(centre.x).toBeGreaterThanOrEqual(COLUMNS * 0.3);
      expect(centre.x).toBeLessThanOrEqual(COLUMNS * 0.7);
      expect(centre.y).toBeGreaterThanOrEqual(ROWS * 0.3);
      expect(centre.y).toBeLessThanOrEqual(ROWS * 0.7);
    }
  });

  it("yields exactly one connected region with no holes", () => {
    for (const seed of [3, 17, 91, 404]) {
      const shape = generateSegmentationShape({ columns: 128, rows: 128, seed });
      const mask = decodeRle(shape.maskRle, 128 * 128);
      expect(countComponents(mask, 128, 128)).toBe(1);

      // No holes: the complement must be a single component too (the
      // background), since the shape never touches the image border.
      const complement = Uint8Array.from(mask, (v) => (v ? 0 : 1));
      expect(countComponents(complement, 128, 128)).toBe(1);
    }
  });

  it("covers a plausible fraction of the image", () => {
    const shape = generateSegmentationShape({ columns: COLUMNS, rows: ROWS, seed: 55 });
    const fraction = shape.pixelCount / (COLUMNS * ROWS);
    expect(fraction).toBeGreaterThan(0.02);
    expect(fraction).toBeLessThan(0.25);
  });

  it("falls back to a centred circle on a tiny image", () => {
    const shape = generateSegmentationShape({ columns: 8, rows: 8, seed: 5 });
    expect(shape.contour.length).toBeGreaterThan(0);
    expect(shape.centre).toEqual({ x: 4, y: 4 });
  });
});
