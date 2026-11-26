import { useEffect } from 'react';
import { NativeModules } from 'react-native';
import type { CockpitHaptic } from './CockpitPlatform.ts';
export function useCockpitPlatform(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    NativeModules.R2CockpitPlatform?.setCockpit(true);
    return () => NativeModules.R2CockpitPlatform?.setCockpit(false);
  }, [active]);
}
export function cockpitHaptic(kind: CockpitHaptic, enabled = true): void {
  if (enabled) NativeModules.R2CockpitPlatform?.haptic(kind);
}
