import { useColors } from "../theme/useColors.ts";
import React from "react";
import { Platform } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { materialSymbolPaths } from "./materialSymbolPaths.ts";
const paths = {
  ...materialSymbolPaths,
  sound: "M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2",
  animation:
    "M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z",
  lights:
    "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z",
  route: "M8 18h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7",
  depot:
    "M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.4-.4-2.4z",
  chevron: "M9 6l6 6-6 6",
  drive: "M7 4.5v15l13-7.5z",
  close: "M6 6l12 12M18 6L6 18",
};
export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 24,
  color,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  const colors = useColors();
  const material = name in materialSymbolPaths;

  return (
    <Svg
      width={size}
      height={size}
      viewBox={material ? "0 -960 960 960" : "0 0 24 24"}
      fill={material ? color ?? colors.primary : "none"}
      stroke={material ? "none" : color ?? colors.primary}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      accessible={Platform.OS === "web" ? undefined : false}
    >
      <Path d={paths[name]} />
      {name === "route" && (
        <>
          <Circle cx={6} cy={18} r={2} />
          <Circle cx={18} cy={6} r={2} />
        </>
      )}
    </Svg>
  );
}
