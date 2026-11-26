/** Raw wire fields; locator/velocity scaling and coordinate units remain unverified. */
export interface StreamField {
  set: 'standard' | 'extended';
  bit: number;
  name: string;
}
const standard: Record<number, string> = {
  25: 'quaternion.x',
  24: 'quaternion.y',
  23: 'quaternion.z',
  22: 'quaternion.w',
  18: 'attitude.pitch',
  17: 'attitude.roll',
  16: 'attitude.yaw',
  15: 'accelerometer.x',
  14: 'accelerometer.y',
  13: 'accelerometer.z',
  12: 'rawGyroscope.x',
  11: 'rawGyroscope.y',
  10: 'rawGyroscope.z',
  9: 'accelOne',
  6: 'locator.x',
  5: 'locator.y',
  4: 'velocity.x',
  3: 'velocity.y',
  2: 'speed',
  1: 'coreTime',
  0: 'processorTemperature'
};
const extended: Record<number, string> = {
  31: 'internal.scalar31',
  30: 'internal.scalar30',
  29: 'internal.scalar29',
  28: 'internal.scalar28',
  27: 'internal.scalar27',
  26: 'headAngle',
  25: 'gyroscope.x',
  24: 'gyroscope.y',
  23: 'gyroscope.z',
  22: 'accelerationMagnitude',
  21: 'scaledSpeed',
  20: 'gyroActivity',
  19: 'accelerationActivity'
};
export const streamFields: StreamField[] = [...Object.entries(standard).map(([bit, name]) => ({
  set: 'standard' as const,
  bit: +bit,
  name
})), ...Object.entries(extended).map(([bit, name]) => ({
  set: 'extended' as const,
  bit: +bit,
  name
}))];
export function selectedFields(standardMask: number, extendedMask: number): StreamField[] {
  return (['standard', 'extended'] as const).flatMap(set => {
    const mask = set === 'standard' ? standardMask : extendedMask;
    const selected: StreamField[] = [];
    for (let bit = 31; bit >= 0; bit--)
      if (mask >>> bit & 1) {
        const name = (set === 'standard' ? standard : extended)[bit];
        if (!name) throw new Error(`Unregistered ${set} stream bit ${bit}`);
        selected.push({
          set,
          bit,
          name
        });
      }
    return selected;
  });
}
export function decodeSensors(data: Uint8Array, standardMask: number, extendedMask = 0): Record<string, number> {
  const fields = selectedFields(standardMask, extendedMask);
  if (data.length !== fields.length * 4) throw new Error(`Sensor payload has ${data.length} bytes; expected ${fields.length * 4}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Object.fromEntries(fields.map((field, i) => [field.name, view.getFloat32(i * 4, false)]));
}
