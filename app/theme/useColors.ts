import {createContext, useContext, useMemo} from 'react';
import {Platform} from 'react-native';
import {colors as webColors} from './tokens.ts';
import {paletteFor} from './appearance.ts';
import type {Appearance, Palette} from './appearance.ts';
export const AppearanceContext = createContext<Appearance>('dark');
/** Native styles resolve on render; web retains its CSS-variable updates. */
export function useColors(): Palette {
  const appearance = useContext(AppearanceContext);
  return Platform.OS === 'web' ? webColors : paletteFor(appearance);
}
export function useThemedStyles<T>(factory: (colors: Palette) => T): T {
  const colors = useColors();
  return useMemo(() => factory(colors), [factory, colors]);
}
