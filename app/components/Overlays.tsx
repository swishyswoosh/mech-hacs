import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import React from "react";
import { Modal, View, ScrollView, StyleSheet, Platform, useWindowDimensions } from "react-native";
import { HudButton, StopButton } from "./Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
export function Sheet({
  title,
  children,
  onClose,
  onStop,
  controls = false,
  compact = false,
}: {
  controls?: boolean;
  compact?: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onStop?: () => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);
  const {height} = useWindowDimensions();
  const low = height < 600;
  const [modalHeight, setModalHeight] = React.useState(height);
  const dialogHeight = Math.max(1, Math.min(height, modalHeight) - 32);

  return (
    <Modal transparent animationType="none" visible onRequestClose={onClose}>
      <View onLayout={event => setModalHeight(event.nativeEvent.layout.height)} style={[s.shade, controls && {padding:16}, compact && {backgroundColor:"rgba(0,0,0,0.45)"}]}>
        <View testID="hub-sheet" accessibilityViewIsModal style={[s.sheet, low && {padding:12,gap:10}, controls && {height:Math.min(440,dialogHeight),maxHeight:"100%",maxWidth:720,minHeight:0}, compact && {maxWidth:540, height:Math.min(260,dialogHeight*0.8)}]}>
          <View style={[s.row,{flexShrink:0}]}>
            <HudText
              accessibilityRole="header"
              kind="heading"
              style={{ flex: 1, fontSize:low ? 16 : 24 }}
            >
              {title}
            </HudText>
            {onStop && <StopButton compact onPress={onStop} />}
            <HudButton
              label={`Close ${title}`}
              icon="close"
              compact
              onPress={onClose}
            />
          </View>
          {controls ? children : <ScrollView
            style={{flexShrink:1,minHeight:0}}
            contentContainerStyle={{ gap: low ? 10 : 16 }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>}
        </View>
      </View>
    </Modal>
  );
}
export function PauseOverlay({
  failed,
  detail,
  onResume,
  onStop,
  onClose,
  onDisconnect,
}: {
  failed: boolean;
  detail: string;
  onResume: () => void;
  onStop: () => void;
  onClose?: () => void;
  onDisconnect: () => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);
  const {height} = useWindowDimensions();
  const compact = height < 600;
  // Native Modal has its own viewport after system bars; window height can be
  // larger. Measure the shade so the fixed action row stays above those bars.
  const [modalHeight, setModalHeight] = React.useState(height);
  const dialogHeight = Math.max(1, Math.min(Math.min(height, modalHeight) - 32, failed ? 390 : 300));
  const actionStyle = {flex:1, minWidth:120, minHeight:36, paddingHorizontal:10, paddingVertical:6};

  return (
    <Modal transparent visible animationType="none" onRequestClose={() => {}}>
      <View onLayout={event => setModalHeight(event.nativeEvent.layout.height)} style={[s.shade, {padding:compact ? 8 : 16}]}>
        <View testID="pause-dialog" accessibilityViewIsModal
          style={[s.sheet, {height:dialogHeight, maxHeight:"100%", minHeight:0, overflow:"hidden", padding:compact ? 12 : 20, gap:compact ? 8 : 12}]}>
          <View style={[s.row,{flexShrink:0}]}>
            <HudText kind="mono" style={{flex:1,color:failed ? colors.danger : colors.caution}}>
              CONTROL PAUSED
            </HudText>
            <StopButton compact prominent onPress={onStop} />
          </View>
          <HudText kind="heading" accessibilityRole="header" style={{fontSize:compact ? 18 : 24,flexShrink:0}}>
            {failed ? "STOP needs attention" : "Controls paused"}
          </HudText>
          <ScrollView testID="pause-details" style={{flex:1,minHeight:0}}
            contentContainerStyle={{gap:8}} keyboardShouldPersistTaps="handled">
            <HudText muted style={{fontSize:compact ? 13 : 15,lineHeight:compact ? 18 : 24}}>
              {failed
                ? detail
                : "Your comlink stays connected. Motion is disarmed and local activities are canceled. Resume never repeats an action."}
            </HudText>
            {failed && <HudText muted style={{fontSize:compact ? 12 : 15,lineHeight:compact ? 17 : 22}}>
              Controls stay blocked after a failed stop. Disconnect only when you choose to end this comlink.
            </HudText>}
          </ScrollView>
          <View testID="pause-actions" style={{flexDirection:"row",flexWrap:"wrap",flexShrink:0,gap:8}}>
            {failed ? <>
              {onClose && <HudButton label="View connection details" onPress={onClose} style={actionStyle} />}
              <HudButton label="Disconnect droid" onPress={onDisconnect} style={actionStyle} />
            </> : <HudButton label="Resume controls" primary onPress={onResume} style={actionStyle} />}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function Toast({
  message,
  onOpen,
  onDismiss,
}: {
  message: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  return (
    <View accessibilityLiveRegion="polite" style={s.toast}>
      <HudText style={{ flex: 1, lineHeight: 22 }} numberOfLines={3}>
        {message}
      </HudText>
      <HudButton label="View notes" icon="notes" compact onPress={onOpen} />
      <HudButton
        label="Dismiss notification"
        icon="close"
        compact
        onPress={onDismiss}
      />
    </View>
  );
}
const make_s = (colors: Palette) => {
  return StyleSheet.create({
  shade: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  sheet: {
    width: "100%",
    maxWidth: 620,
    maxHeight: "90%",
    padding: 24,
    gap: 20,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: 16,
    backgroundColor: colors.panel,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  toast: {
    position: "absolute",
    bottom: 18,
    left: 16,
    right: 16,
    maxWidth: 700,
    alignSelf: "center",
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.panelRaised,
    padding: 14,
    gap: 10,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    zIndex: 10,
  },
});
};
