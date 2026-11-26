export type CockpitGamepadSample = {
  at: number;
  deviceId: string;
  axes: number[];
  buttons: boolean[];
  edge?: { button: number; pressed: boolean; repeat: boolean };
};
export async function startCockpitGamepad(
  _onSample: (sample: CockpitGamepadSample) => void,
  _onRevoke: (reason: string) => void,
): Promise<() => void> {
  throw new Error('Use the browser Gamepad API on web.');
}
