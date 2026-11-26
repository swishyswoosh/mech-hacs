import { useColors } from "../theme/useColors.ts";
import React from "react";
import { Platform } from "react-native";
import { HudButton } from "./Hud.tsx";
import { repeatedPulseKey } from "../../core/accessiblePulse.ts";
import { fonts } from "../theme/tokens.ts";
/** A held keyboard activation must never become a chain of finite pulses. */
export function PulseButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const colors = useColors();

  if (Platform.OS !== "web")
    return <HudButton label={label} disabled={disabled} onPress={onPress} />;
  return React.createElement(
    "button",
    {
      type: "button",
      disabled,
      "aria-label": label,
      onClick: onPress,
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (repeatedPulseKey(event.key, event.repeat)) event.preventDefault();
      },
      style: {
        minHeight: 56,
        padding: "12px 18px",
        border: `1px solid ${colors.line2}`,
        borderRadius: 10,
        background: colors.panel,
        color: colors.primary,
        fontFamily: fonts.heading,
        fontSize: 18,
        opacity: disabled ? 0.45 : 1,
      },
    },
    label,
  );
}
