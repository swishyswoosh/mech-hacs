import { NativeEventEmitter, NativeModules } from 'react-native';
import type { CockpitGamepadSample } from './startCockpitGamepad.ts';
export type { CockpitGamepadSample } from './startCockpitGamepad.ts';
export async function startCockpitGamepad(
  onSample: (sample: CockpitGamepadSample) => void,
  onRevoke: (reason: string) => void,
): Promise<() => void> {
  const bridge = NativeModules.R2ExternalInput;
  if (!bridge?.startCockpit) throw new Error('Native cockpit gamepad is unavailable in this build.');
  let stopped = false;
  const events = new NativeEventEmitter<{R2ExternalInputSample: [{kind:'revoked';reason:string} | (Omit<CockpitGamepadSample,'deviceId'> & {kind:'cockpitGamepad';deviceId:number})]}>(bridge);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    subscription.remove();
    void bridge.stop().catch(() => {});
  };
  const subscription = events.addListener('R2ExternalInputSample', event => {
    if (stopped) return;
    if (event.kind === 'revoked') {
      stop();
      onRevoke(event.reason);
    } else if (event.kind === 'cockpitGamepad') {
      onSample({ ...event, deviceId: String(event.deviceId) });
    }
  });
  try { await bridge.startCockpit(); } catch (error) { stop(); throw error; }
  return stop;
}
