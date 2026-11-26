import { arcade } from './drive.ts';
export type ExternalInputMode = 'gamepad' | 'tilt';
export type ExternalInputSample = {
  kind: 'gamepad';
  at: number;
  deviceId: string;
  x: number;
  y: number;
  deadman: boolean;
} | {
  kind: 'tilt';
  at: number;
  beta: number;
  gamma: number;
};
const clamp = (value: number) => Math.max(-1, Math.min(1, value));
const angleDelta = (value: number, origin: number) => (value - origin + 540) % 360 - 180;
/** Platform-independent input intent only. No sampling or activation sends a command. */
export class ExternalDriveSession {
  mode?: ExternalInputMode;
  reason = 'Inactive';
  private epoch?: number;
  private activatedAt = 0;
  private lastAt?: number;
  private neutral?: {
    beta: number;
    gamma: number;
  };
  private deviceId?: string;
  private released = false;
  private held = false;
  private point: [number, number] = [0, 0];
  activate(mode: ExternalInputMode, epoch: number, now: number) {
    this.mode = mode;
    this.epoch = epoch;
    this.activatedAt = now;
    this.lastAt = undefined;
    this.neutral = undefined;
    this.deviceId = undefined;
    this.released = false;
    this.held = false;
    this.point = [0, 0];
    this.reason = mode === 'gamepad' ? 'Release the left shoulder button before driving' : 'Waiting for a neutral phone sample';
  }
  revoke(reason = 'Input revoked') {
    this.mode = undefined;
    this.held = false;
    this.point = [0, 0];
    this.lastAt = undefined;
    this.reason = reason;
  }
  observeSession(epoch: number, ready: boolean) {
    if (this.mode && (!ready || epoch !== this.epoch)) this.revoke('Connection changed; activate again after validation');
  }
  setTiltDeadman(held: boolean) {
    if (this.mode === 'tilt') this.held = held;
  }
  accept(sample: ExternalInputSample) {
    if (!this.mode || sample.kind !== this.mode) return;
    if (!Number.isFinite(sample.at) || this.lastAt !== undefined && sample.at < this.lastAt) {
      this.revoke('Input timestamp invalid');
      return;
    }
    if (sample.kind === 'gamepad') {
      if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y) || typeof sample.deadman !== 'boolean' || !sample.deviceId) {
        this.revoke('Gamepad data invalid');
        return;
      }
      if (this.deviceId !== undefined && sample.deviceId !== this.deviceId) {
        this.revoke('Gamepad changed; activate again');
        return;
      }
      this.deviceId = sample.deviceId;
      this.point = [clamp(sample.x), clamp(sample.y)];
      if (!sample.deadman) this.released = true;
      this.held = sample.deadman && this.released;
      this.reason = this.released ? 'Left stick steers; hold left shoulder to drive' : 'Release left shoulder before driving';
    } else {
      if (!Number.isFinite(sample.beta) || !Number.isFinite(sample.gamma)) {
        this.revoke('Phone orientation invalid');
        return;
      }
      if (!this.neutral) this.neutral = {
        beta: sample.beta,
        gamma: sample.gamma
      };
      this.point = [clamp(angleDelta(sample.gamma, this.neutral.gamma) / 30), clamp(-angleDelta(sample.beta, this.neutral.beta) / 30)];
      this.reason = 'Neutral captured; hold the phone deadman to drive';
    }
    this.lastAt = sample.at;
  }
  demand(now: number, speed: number) {
    if (this.mode && (this.lastAt === undefined && now - this.activatedAt > 1500 || this.lastAt !== undefined && (now - this.lastAt > 300 || now < this.lastAt))) this.revoke('Input stale; explicit reactivation required');
    const driving = !!this.mode && this.held && this.lastAt !== undefined;
    const point: [number, number] = driving ? [...this.point] : [0, 0];
    return {
      active: !!this.mode,
      driving,
      point,
      wheels: arcade(...point, speed),
      reason: this.reason
    };
  }
}
