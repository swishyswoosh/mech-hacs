import { StyleSheet } from "react-native";
import type { Palette } from "../theme/appearance.ts";
export const makePathStyles = (colors: Palette) => StyleSheet.create({
  page: { padding: 20, gap: 18, paddingBottom: 48 },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
  },
  heading: { fontSize: 20 },
  canvas: {
    height: 280,
    width: "100%",
    backgroundColor: colors.bg,
    borderColor: colors.line2,
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
});
