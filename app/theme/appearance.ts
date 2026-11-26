import {darkPalette, lightPalette} from './palettes.ts';
export type Appearance = 'light' | 'dark';
export type Palette = typeof darkPalette;
export function paletteFor(appearance: Appearance): Palette {
  return appearance === 'light' ? lightPalette : darkPalette;
}
export function inputTheme(colors: Palette) {
  return {
    inputPalette: {caret: colors.primary, selection: colors.selection, placeholder: colors.textMuted},
    inputSurface: {backgroundColor: colors.bg, color: colors.text, caretColor: colors.primary, fontFamily: 'Inter'},
  };
}
