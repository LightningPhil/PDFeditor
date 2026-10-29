export interface Point {
  x: number;
  y: number;
}
export type Matrix = [number, number, number, number, number, number];
export const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function transform(matrix: Matrix, point: Point): Point {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
  };
}
export function inverseVector(matrix: Matrix, vector: Point): Point {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
    throw new Error(
      "This text has a non-invertible transformation and cannot be moved.",
    );
  return {
    x: (matrix[3] * vector.x - matrix[2] * vector.y) / determinant,
    y: (matrix[0] * vector.y - matrix[1] * vector.x) / determinant,
  };
}
export function bounds(points: Point[]) {
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    top = -Infinity;
  for (const point of points) {
    x = Math.min(x, point.x);
    y = Math.min(y, point.y);
    right = Math.max(right, point.x);
    top = Math.max(top, point.y);
  }
  return { x, y, width: right - x, height: top - y };
}
