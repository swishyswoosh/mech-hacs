/** Voltage alone supports an empirical runtime estimate, not measured state of charge. */
export type BatterySample = {at: number; volts: number; quiet: boolean; state?: number};
export type BatteryCycle = {
  id: string;
  deviceKey: string;
  startedAt: number;
  full: 'reported' | 'confirmed';
  endedAt?: number;
  endpoint?: 'critical' | 'shutdown';
  problem?: string;
  dischargeObserved?: boolean;
  samples: BatterySample[];
};
export type BatteryProfile = {
  version: 1;
  id: string;
  deviceKey: string;
  basis: 'usable-runtime';
  createdAt: number;
  points: Array<{volts: number; percent: number}>;
  trainingCycleIds: string[];
  validationCycleId: string;
  validation: {meanError: number; maxError: number};
};
export type BatteryProfileResult = {
  profile?: BatteryProfile;
  issues: string[];
  usableCycles: number;
  excluded: string[];
};
export const BATTERY_CALIBRATION = {
  minCycles: 3,
  minSamples: 20,
  minDurationMs: 15 * 60000,
  maxGapMs: 5 * 60000,
  endpointWindowMs: 2 * 60000,
  minSpanVolts: 0.1,
  maxMeanError: 10,
  maxError: 20
} as const;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
function cycleIssue(c: BatteryCycle, key: string): string | undefined {
  if (c.deviceKey !== key) return 'belongs to another droid';
  if (c.problem) return c.problem;
  if (!c.endedAt || !c.endpoint) return 'cycle is incomplete';
  if (c.full !== 'confirmed' && c.full !== 'reported') return 'full-charge start is unconfirmed';
  if (c.endedAt - c.startedAt < BATTERY_CALIBRATION.minDurationMs)
    return 'needs at least 15 minutes of discharge';
  if (c.samples.some((s) => !finite(s.at) || !finite(s.volts) || s.volts <= 0 || s.volts > 655.35))
    return 'contains an invalid voltage or timestamp';
  const samples = c.samples.filter((s) => s.quiet);
  if (samples.length < BATTERY_CALIBRATION.minSamples)
    return 'needs at least 20 quiet voltage readings';
  if (samples[0].at < c.startedAt || samples.at(-1)!.at > c.endedAt)
    return 'timestamps lie outside the confirmed cycle';
  if (
    samples[0].at - c.startedAt > BATTERY_CALIBRATION.endpointWindowMs ||
    c.endedAt - samples.at(-1)!.at > BATTERY_CALIBRATION.endpointWindowMs
  )
    return 'needs a quiet reading within two minutes of each endpoint';
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].at <= samples[i - 1].at) return 'clock or sample order changed';
    if (samples[i].at - samples[i - 1].at > BATTERY_CALIBRATION.maxGapMs)
      return 'quiet-reading gap exceeds five minutes';
  }
  if (samples[0].volts - samples.at(-1)!.volts < BATTERY_CALIBRATION.minSpanVolts - 1e-8)
    return 'full-to-low voltage span must be at least 0.10 V';
  return undefined;
}
function voltageAt(c: BatteryCycle, percent: number) {
  const samples = c.samples.filter((s) => s.quiet),
    at = c.startedAt + (c.endedAt! - c.startedAt) * (1 - percent / 100);
  if (at <= samples[0].at) return samples[0].volts;
  for (let i = 1; i < samples.length; i++)
    if (at <= samples[i].at) {
      const a = samples[i - 1],
        b = samples[i];
      return a.volts + ((b.volts - a.volts) * (at - a.at)) / (b.at - a.at);
    }
  return samples.at(-1)!.volts;
}
/** Pool-adjacent-violators removes local rebounds without pretending the curve is linear. */
function curve(cycles: BatteryCycle[]): BatteryProfile['points'] {
  const blocks: Array<{sum: number; count: number; first: number; last: number}> = [];
  for (let i = 0; i <= 10; i++) {
    const volts = cycles.reduce((sum, c) => sum + voltageAt(c, i * 10), 0) / cycles.length;
    blocks.push({sum: volts, count: 1, first: i, last: i});
    while (blocks.length > 1) {
      const b = blocks.at(-1)!,
        a = blocks.at(-2)!;
      if (a.sum / a.count <= b.sum / b.count) break;
      blocks.splice(-2, 2, {
        sum: a.sum + b.sum,
        count: a.count + b.count,
        first: a.first,
        last: b.last
      });
    }
  }
  const points: BatteryProfile['points'] = [];
  for (const b of blocks) {
    const point = {volts: b.sum / b.count, percent: (b.first + b.last) * 5},
      previous = points.at(-1);
    if (previous && point.volts - previous.volts < 0.005) {
      previous.volts = (previous.volts + point.volts) / 2;
      previous.percent = (previous.percent + point.percent) / 2;
    } else points.push(point);
  }
  if (points.length) {
    points[0].percent = 0;
    points.at(-1)!.percent = 100;
  }
  return points;
}
export function estimateBatteryPercent(profile: BatteryProfile, volts: number): number | undefined {
  const points = profile.points;
  if (
    !finite(volts) ||
    points.length < 3 ||
    volts < points[0].volts - 0.05 ||
    volts > points.at(-1)!.volts + 0.05
  )
    return undefined;
  if (volts <= points[0].volts) return 0;
  for (let i = 1; i < points.length; i++)
    if (volts <= points[i].volts) {
      const a = points[i - 1],
        b = points[i],
        p = a.percent + ((b.percent - a.percent) * (volts - a.volts)) / (b.volts - a.volts);
      return Math.max(0, Math.min(100, Math.round(p / 5) * 5));
    }
  return 100;
}
function fingerprint(value: unknown) {
  let hash = 2166136261;
  for (const char of JSON.stringify(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
export function buildBatteryProfile(
  deviceKey: string,
  cycles: BatteryCycle[]
): BatteryProfileResult {
  const excluded: string[] = [],
    eligible: BatteryCycle[] = [];
  for (const cycle of cycles) {
    const issue = cycleIssue(cycle, deviceKey);
    if (issue) excluded.push(`Cycle ${cycle.id}: ${issue}.`);
    else eligible.push(cycle);
  }
  eligible.sort((a, b) => a.endedAt! - b.endedAt!);
  const endpoint = eligible.at(-1)?.endpoint,
    compatible = eligible.filter((c) => c.endpoint === endpoint);
  const result: BatteryProfileResult = {issues: [], usableCycles: compatible.length, excluded};
  if (compatible.length < 3) {
    result.issues = [
      `Need three complete cycles with the same low-battery endpoint (two for training, one for validation); ${compatible.length} usable.`,
      ...excluded
    ];
    return result;
  }
  const training = compatible.slice(0, -1),
    heldOut = compatible.at(-1)!,
    points = curve(training);
  if (points.length < 3 || points.at(-1)!.volts - points[0].volts < 0.1 - 1e-8) {
    result.issues = ['The voltage curve does not distinguish enough of the discharge.'];
    return result;
  }
  const profile: BatteryProfile = {
    version: 1,
    id: '',
    deviceKey,
    basis: 'usable-runtime',
    createdAt: heldOut.endedAt!,
    points,
    trainingCycleIds: training.map((c) => c.id),
    validationCycleId: heldOut.id,
    validation: {meanError: 0, maxError: 0}
  };
  const errors = Array.from({length: 21}, (_, i) => {
    const percent = i * 5,
      predicted = estimateBatteryPercent(profile, voltageAt(heldOut, percent));
    return predicted === undefined ? 100 : Math.abs(predicted - percent);
  });
  profile.validation = {
    meanError: errors.reduce((a, b) => a + b, 0) / errors.length,
    maxError: Math.max(...errors)
  };
  if (profile.validation.meanError > 10 || profile.validation.maxError > 20) {
    result.issues = [
      `Held-out validation error is too large: mean ${profile.validation.meanError.toFixed(1)}, maximum ${profile.validation.maxError.toFixed(1)} percentage points (limits 10 and 20).`
    ];
    return result;
  }
  profile.id = `battery-${fingerprint({deviceKey, cycles: compatible, points})}`;
  result.profile = profile;
  return result;
}
export function validBatteryProfile(p: any): p is BatteryProfile {
  return (
    !!p &&
    p.version === 1 &&
    typeof p.id === 'string' &&
    typeof p.deviceKey === 'string' &&
    p.basis === 'usable-runtime' &&
    finite(p.createdAt) &&
    Array.isArray(p.trainingCycleIds) &&
    p.trainingCycleIds.length >= 2 &&
    p.trainingCycleIds.every((id: unknown) => typeof id === 'string') &&
    typeof p.validationCycleId === 'string' &&
    !p.trainingCycleIds.includes(p.validationCycleId) &&
    finite(p.validation?.meanError) &&
    p.validation.meanError >= 0 &&
    p.validation.meanError <= 10 &&
    finite(p.validation.maxError) &&
    p.validation.maxError >= p.validation.meanError &&
    p.validation.maxError <= 20 &&
    Array.isArray(p.points) &&
    p.points.length >= 3 &&
    p.points.length <= 11 &&
    p.points[0].percent === 0 &&
    p.points.at(-1).percent === 100 &&
    p.points.every(
      (point: any, i: number) =>
        finite(point.volts) &&
        point.volts > 0 &&
        finite(point.percent) &&
        point.percent >= 0 &&
        point.percent <= 100 &&
        (!i || (point.volts > p.points[i - 1].volts && point.percent > p.points[i - 1].percent))
    )
  );
}
