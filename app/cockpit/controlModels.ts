/** Radial dead zone and squared response, shared by every non-native drive source. */
export function shapePoint(x: number, y: number): [number, number] {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [0, 0];
  const length = Math.hypot(x, y);
  if (length <= 0.08) return [0, 0];
  const response = ((Math.min(1, length) - 0.08) / 0.92) ** 2;
  return [(x / length) * response, (y / length) * response];
}
export function shapeAxis(x: number) {
  return shapePoint(x, 0)[0];
}
export class FloatingJoystick {
  pointer?: number;
  origin: [number, number] = [0, 0];
  begin(pointer: number, x: number, y: number): [number, number] | undefined {
    if (this.pointer !== undefined) return;
    this.pointer = pointer;
    this.origin = [x, y];
    return [0, 0];
  }
  move(pointer: number, x: number, y: number, radius: number) {
    if (this.pointer !== pointer || !Number.isFinite(radius) || radius <= 0)
      return;
    return shapePoint(
      (x - this.origin[0]) / radius,
      (this.origin[1] - y) / radius,
    );
  }
  end(pointer: number) {
    if (this.pointer !== pointer) return false;
    this.cancel();
    return true;
  }
  cancel() {
    this.pointer = undefined;
  }
}
export function angleAt(x: number, y: number) {
  const angle = (Math.atan2(x, -y) * 180) / Math.PI;
  return Math.round(Math.max(-160, Math.min(180, angle)));
}

/** arcade() already removes a radial dead zone. Encode a shaped demand so its
 * existing normalization yields the requested expo response, without a second dead zone. */
export function toArcadeInput(point: [number, number]): [number, number] {
  const radius = Math.hypot(...point);
  if (!radius) return [0, 0];
  const scale = (0.08 + 0.92 * Math.min(1, radius)) / radius;
  return [point[0] * scale, point[1] * scale];
}

export class DomeGesture {
  pointer?: number;
  begin(id: number) {
    if (this.pointer !== undefined) return false;
    this.pointer = id;
    return true;
  }
  move(id: number, x: number, y: number) {
    return this.pointer === id ? angleAt(x, y) : undefined;
  }
  cancel() {
    this.pointer = undefined;
  }
}
