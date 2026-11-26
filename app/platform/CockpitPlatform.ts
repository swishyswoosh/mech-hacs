import { useEffect } from 'react';
export type CockpitHaptic = 'arm' | 'stop' | 'gear';
/** Web orientation is a PWA preference; never force fullscreen or reload a session. */
export function useCockpitPlatform(_active: boolean): void {
  useEffect(() => {}, []);
}
export function cockpitHaptic(_kind: CockpitHaptic, _enabled = true): void {}
