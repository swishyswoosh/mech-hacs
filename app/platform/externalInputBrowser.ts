import type { ExternalInputMode, ExternalInputSample } from '../../core/externalInput.ts';
type BrowserGamepad = Pick<Gamepad, 'id' | 'index' | 'mapping' | 'connected' | 'axes' | 'buttons' | 'timestamp'>;
type GamepadSample = Extract<ExternalInputSample, {
  kind: 'gamepad';
}>;
export function standardGamepadSample(gamepad: BrowserGamepad, timeOrigin: number): GamepadSample {
  if (!gamepad.connected || gamepad.mapping !== 'standard' || gamepad.axes.length < 2 || gamepad.buttons.length <= 4 || typeof gamepad.buttons[4]?.pressed !== 'boolean') throw new Error('A connected standard-mapped gamepad with a left shoulder button is required.');
  if (!Number.isFinite(gamepad.timestamp) || gamepad.timestamp <= 0 || !Number.isFinite(timeOrigin) || timeOrigin <= 0) throw new Error('Gamepad hardware timestamp unavailable. Fresh hardware input cannot be established; external driving stays inactive.');
  const at = Math.floor(orientationEventTime(gamepad.timestamp, timeOrigin));
  return {
    kind: 'gamepad',
    at,
    deviceId: `${gamepad.index}:${gamepad.id}`,
    x: gamepad.axes[0],
    y: -gamepad.axes[1],
    deadman: gamepad.buttons[4].pressed
  };
}
/** Browser polling only observes hardware data. Cached state never renews its
 * timestamp; devices that report only on changes intentionally fail closed. */
export class BrowserGamepadSampler {
  private timeOrigin: number;
  private previous?: GamepadSample;
  private hardwareTimestamp?: number;
  constructor(timeOrigin: number) {
    this.timeOrigin = timeOrigin;
  }
  read(gamepad: BrowserGamepad, now: number): GamepadSample | undefined {
    const sample = standardGamepadSample(gamepad, this.timeOrigin);
    if (!Number.isFinite(now) || sample.at > now) throw new Error('Gamepad hardware timestamp is invalid or in the future.');
    if (now - sample.at > 300) throw new Error('Gamepad hardware timestamp stale or frozen. Stationary controllers may stop; move/release controls and explicitly activate again.');
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) throw new Error('Gamepad axes are invalid.');
    if (this.previous) {
      if (sample.deviceId !== this.previous.deviceId) throw new Error('Gamepad changed; activate again.');
      if (gamepad.timestamp < this.hardwareTimestamp!) throw new Error('Gamepad hardware timestamp regressed.');
      if (gamepad.timestamp === this.hardwareTimestamp) {
        if (sample.x !== this.previous.x || sample.y !== this.previous.y || sample.deadman !== this.previous.deadman) throw new Error('Gamepad state changed without hardware timestamp advancement. Fresh input cannot be established.');
        return;
      }
    }
    this.previous = sample;
    this.hardwareTimestamp = gamepad.timestamp;
    return sample;
  }
}
export function orientationEventTime(timestamp: number, timeOrigin: number) {
  return timestamp > 1_000_000_000_000 ? timestamp : timeOrigin + timestamp;
}
export async function requestOrientationAccess(api: {
  requestPermission?: () => Promise<string>;
} | undefined, secure: boolean) {
  if (!secure || !api) throw new Error('Phone tilt needs a supported secure browser and device orientation API.');
  if (api.requestPermission && (await api.requestPermission()) !== 'granted') throw new Error('Phone motion permission was denied. Tilt remains inactive.');
}
export async function startExternalInput(mode: ExternalInputMode, onSample: (sample: ExternalInputSample) => void, onRevoke: (reason: string) => void): Promise<() => void> {
  if (typeof window === 'undefined' || document.hidden || !document.hasFocus()) throw new Error('Keep this page visible and focused before activating external controls.');
  let stop = () => {},
    stopped = false;
  const revoke = (reason: string) => {
    if (stopped) return;
    stop();
    onRevoke(reason);
  };
  if (mode === 'gamepad') {
    if (!navigator.getGamepads) throw new Error('This browser does not expose the Gamepad API.');
    const gamepad = Array.from(navigator.getGamepads()).find(pad => pad?.connected && pad.mapping === 'standard');
    if (!gamepad) throw new Error('Connect a standard gamepad and press a button, then activate again.');
    const index = gamepad.index,
      id = gamepad.id,
      sampler = new BrowserGamepadSampler(performance.timeOrigin);
    const poll = () => {
      try {
        const current = navigator.getGamepads()[index];
        if (!current || current.id !== id) throw new Error('Gamepad disconnected or changed');
        const sample = sampler.read(current, Date.now());
        if (sample) onSample(sample);
      } catch (error) {
        revoke(String(error));
      }
    };
    const timer = setInterval(poll, 50),
      disconnected = (event: GamepadEvent) => {
        if (event.gamepad.index === index) revoke('Gamepad disconnected; activate again after reconnecting.');
      };
    stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('gamepaddisconnected', disconnected);
    };
    window.addEventListener('gamepaddisconnected', disconnected);
    poll();
  } else {
    const orientationApi = globalThis.DeviceOrientationEvent as (typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<string>;
    }) | undefined;
    await requestOrientationAccess(orientationApi, globalThis.isSecureContext);
    if (document.hidden || !document.hasFocus()) throw new Error('Focus was lost during phone permission. Activate again while focused.');
    const orientation = (event: DeviceOrientationEvent) => {
      if (event.beta !== null && event.gamma !== null) onSample({
        kind: 'tilt',
        at: orientationEventTime(event.timeStamp, performance.timeOrigin),
        beta: event.beta,
        gamma: event.gamma
      });
    };
    const changed = () => revoke('Screen orientation changed; activate and capture neutral again.');
    stop = () => {
      if (stopped) return;
      stopped = true;
      window.removeEventListener('deviceorientation', orientation);
      window.removeEventListener('orientationchange', changed);
    };
    window.addEventListener('deviceorientation', orientation);
    window.addEventListener('orientationchange', changed);
  }
  return stop;
}
