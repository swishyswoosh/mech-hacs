import { colors, fonts } from "./tokens.ts";
export const inputPalette = {
  caret: colors.primary,
  selection: colors.selection,
  placeholder: colors.textMuted,
};
export const inputSurface = {
  backgroundColor: colors.bg,
  color: colors.text,
  caretColor: inputPalette.caret,
  fontFamily: fonts.body,
};
