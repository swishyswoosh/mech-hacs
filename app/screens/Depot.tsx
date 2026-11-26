import {BatteryProfilingPanel} from "../workshop/BatteryProfilingPanel.tsx";
import {FirmwareControls} from "../workshop/FirmwareControls.tsx";
import {readOptionalPreference} from '../library/optionalPreference.ts';
import {recoveredCommands} from "../../core/recoveredControls.ts";
import { useColors } from "../theme/useColors.ts";
import { HudPage, HudPageTitle } from "../components/HudPage.tsx";
import React, { useEffect, useState } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  View,
  Pressable,
  useWindowDimensions,
} from "react-native";
import {DepotButton as HudButton, DepotPanel as HudPanel, DepotDetails} from "../workshop/CompactLayout.tsx";
import { HudText } from "../theme/Theme.tsx";
import { DiagnosticsPanel } from "../workshop/DiagnosticsPanel.tsx";
import { useSensorTools } from "../workshop/SensorTools.tsx";
import { FineExtras } from "../workshop/FineExtras.tsx";
import { DroidReadbacks } from "../workshop/DroidReadbacks.tsx";
import { AudioControls } from "../workshop/AudioControls.tsx";
import { RawConsole } from "../workshop/RawConsole.tsx";
import { Unavailable } from "../workshop/Unavailable.tsx";
import { Field } from "../workshop/Controls.tsx";
import { commands, requiresMotionArm } from "../../core/index.ts";
import type { Command } from "../../core/index.ts";
import type { AppPort, AppSnapshot } from "../session/types.ts";
import type { ManualMotionLease } from "../session/ManualMotion.ts";
export type DepotProps = {
  port: AppPort;
  snapshot: AppSnapshot;
  ready?: boolean;
  packets?: string[];
  stopToken: number;
  onMessage: (message: string) => void;
  execute: (command: Command) => Promise<unknown>;
  beforeService: () => void;
  exiting?: boolean;
  registerBack?: (handler: () => boolean) => () => void;
  registerCancel?: (cancel: () => void) => () => void;
  onRecordingChange?: (recording: boolean) => void;
  onStartSensors: () => void;
  onStopSensors: () => void;
  onSleep: () => Promise<unknown>;
  manualMotion: ManualMotionLease;
  beforeManualInput?: () => void;
  executeNativePulse?: (command: Command) => Promise<void>;
  additionalControls?: React.ReactNode;
};
type Section =
  | "Overview"
  | "Sensors"
  | "Battery profiling"
  | "Service & capabilities"
  | "Advanced drive"
  | "Articulation"
  | "LED channels"
  | "Audio & modes"
  | "Events & modes"
  | "Droid Readbacks"
  | "Raw console"
  | "Bluetooth"
  | "Firmware";
const sections: Section[] = [
  "Overview",
  "Sensors",
  "Battery profiling",
  "Service & capabilities",
  "Advanced drive",
  "Articulation",
  "LED channels",
  "Audio & modes",
  "Events & modes",
  "Droid Readbacks",
  "Raw console",
  "Bluetooth",
  "Firmware",
];
export function Depot({
  port,
  snapshot,
  ready = snapshot.state === "ready",
  packets = snapshot.packets,
  stopToken,
  onMessage,
  execute,
  beforeService,
  exiting = false,
  registerBack,
  registerCancel,
  onRecordingChange,
  onStartSensors,
  onStopSensors,
  onSleep,
  manualMotion,
  beforeManualInput,
  executeNativePulse,
  additionalControls,
}: DepotProps) {
  const colors = useColors();

  const { width } = useWindowDimensions();
  const narrow = width < 700;
  const [servicesRead] = useState(() => readOptionalPreference(port, 'services', 'Bluetooth services'));
  const [section, setSection] = useState<Section>("Overview"),
    [services, setServices] = useState(
      () =>
        servicesRead.value ||
        "00010001-574f-4f20-5370-6865726f2121, 00020001-574f-4f20-5370-6865726f2121",
    );
  const effectiveSnapshot = ready
    ? snapshot
    : { ...snapshot, state: "disconnected" as const };
  const localBack = React.useRef<(() => boolean) | undefined>(undefined);
  const registerLocalBack = React.useCallback((handler: () => boolean) => {
    localBack.current = handler;
    return () => {
      if (localBack.current === handler) localBack.current = undefined;
    };
  }, []);
  useEffect(
    () =>
      registerBack?.(() => {
        if (localBack.current?.()) return true;
        if (section === "Overview") return false;
        setSection("Overview");
        return true;
      }),
    [registerBack, section],
  );
  // This hook owns capture independently of the rendered section. No hidden panel is mounted.
  const sensors = useSensorTools({
    snapshot: effectiveSnapshot,
    port,
    onRecordingChange,
    stopToken,
    onStartSensors,
    onStopSensors,
    registerBack: section === "Sensors" ? registerLocalBack : undefined,
    onOpenService: () => setSection("Service & capabilities"),
    visible: section === "Sensors",
  });
  const send = async (command: Command) => {
    if (!ready)
      throw new Error("Resume the ready droid before sending commands.");
    if (manualMotion.active && requiresMotionArm(command))
      throw new Error("Release active manual motion first.");
    beforeManualInput?.();
    if (requiresMotionArm(command)) port.armMotion();
    return execute(command);
  };
  const finePage =
    section === "Advanced drive"
      ? "Drive"
      : section === "Articulation"
        ? "Dome & Stance"
        : section === "LED channels"
          ? "Lights"
          : section === "Audio & modes"
            ? "Audio"
            : undefined;
  const fine = (page: string) => (
    <FineExtras
      page={page}
      port={port}
      snapshot={effectiveSnapshot}
      execute={execute}
      onMessage={onMessage}
      registerCancel={registerCancel}
      beforeManualInput={beforeManualInput}
      manualMotion={manualMotion}
      executeNativePulse={executeNativePulse}
    />
  );
  return (
    <View
      style={{
        flex: 1,
        flexDirection: narrow ? "column" : "row",
        minHeight: 0,
      }}
    >
      <ScrollView
        horizontal={narrow}
        style={{
          flexGrow: 0,
          width: narrow ? undefined : 184,
          borderRightWidth: narrow ? 0 : 1,
          borderBottomWidth: narrow ? 1 : 0,
          borderColor: colors.line,
          backgroundColor: colors.panel,
        }}
        contentContainerStyle={{ padding: 6, gap: 2 }}
      >
        {!narrow && (
          <HudText
            kind="heading"
            style={{ fontSize: 16, color: colors.primary, padding: 6 }}
          >
            Depot
          </HudText>
        )}
        {sections.map((name) => (
          <Pressable
            key={name}
            accessibilityRole="tab"
            accessibilityLabel={name}
            accessibilityState={{ selected: section === name }}
            onPress={() => setSection(name)}
            style={{
              minHeight: Platform.OS === "web" ? 32 : 40,
              paddingHorizontal: 12,
              justifyContent: "center",
              borderLeftWidth: 2,
              borderColor: section === name ? colors.primary : "transparent",
              borderRadius: 6,
              backgroundColor:
                section === name ? colors.panelRaised : "transparent",
            }}
          >
            <HudText
              kind="heading"
              style={{
                fontSize: 13,
                color: section === name ? colors.primary : colors.textMuted,
              }}
            >
              {name}
            </HudText>
          </Pressable>
        ))}
      </ScrollView>
      <HudPage contentContainerStyle={{padding:12,paddingBottom:12,gap:10}}>
        {!!servicesRead.error && <HudText accessibilityRole="alert" style={{fontSize: 12}}>{servicesRead.error}</HudText>}
        <HudPageTitle
          title={section === "Overview" ? "Depot" : section}
          compact
        />
        {section === "Overview" && (
          <HudPanel>
            <HudText>
              Inspect capabilities and packets, capture sensor streams, review
              service reads, and use detailed control encoders.
            </HudText>
            <HudText muted>
              Sensor recording continues while you change screens. Opening
              service stops active sources and disarms motion. Leaving Depot
              must finish the service-exit barrier before navigating.
            </HudText>
            <View style={s.row}>
            <HudButton
              label="Inspect sensor streams"
              caution
              onPress={() => setSection("Sensors")}
            />
            <HudButton
              label="Service session & capability registry"
              caution
              onPress={() => setSection("Service & capabilities")}
            />
            <HudButton
              label="Firmware & validation details"
              caution
              onPress={() => setSection("Firmware")}
            />
            </View>
          </HudPanel>
        )}
        {section === "Sensors" && sensors}
        {section === "Battery profiling" && <BatteryProfilingPanel port={port} summary={snapshot.batteryProfiling} ready={ready} />}
        {section === "Service & capabilities" && (
          <DiagnosticsPanel
            packets={packets}
            port={port}
            snapshot={effectiveSnapshot}
            beforeService={beforeService}
            exiting={exiting}
            registerBack={registerLocalBack}
          />
        )}
        {section === "Advanced drive" && additionalControls && <DepotDetails title="Wheel checks & external steering">{additionalControls}</DepotDetails>}
        {finePage && fine(finePage)}
        {section === "Audio & modes" && (
          <AudioControls ready={ready} execute={send} onMessage={onMessage} />
        )}
        {section === "Audio & modes" && (
          <>
            <HudPanel>
              <HudText kind="heading" style={{ fontSize: 17 }}>
                Behavior modes
              </HudText>
              {[
                ["Idle animations", commands.idleAnimations],
                ["Trophy mode", commands.trophy],
                ["Droid interaction", commands.droidInteraction],
              ].map(([name, builder]) => (
                <View key={String(name)} style={s.row}>
                  <HudText style={{minWidth:130,flexGrow:1}}>{String(name)}</HudText>
                  <View style={s.row}>
                    {[true, false].map((enabled) => (
                      <HudButton
                        key={String(enabled)}
                        label={`${enabled ? "Enable" : "Disable"} ${name}`}
                        disabled={!ready}
                        onPress={() => {
                          void send(
                            (builder as (value: boolean) => Command)(enabled),
                          ).catch((error) => onMessage(String(error)));
                        }}
                      />
                    ))}
                  </View>
                </View>
              ))}
            </HudPanel>
          </>
        )}
        {section === "Events & modes" && <FirmwareControls port={port} ready={ready} connectionEpoch={snapshot.connectionEpoch} execute={send}/>}
        {section === "LED channels" && (
          <HudButton
            label="Start idle LED animation"
            disabled={!ready}
            onPress={() => void send(recoveredCommands.startIdleLedAnimation()).catch(error => onMessage(String(error)))}
          />
        )}
        {section === "Droid Readbacks" && (
          <DroidReadbacks
            snapshot={effectiveSnapshot}
            execute={execute}
            onSleep={onSleep}
            registerBack={registerLocalBack}
          />
        )}
        {section === "Raw console" && (
          <RawConsole ready={ready} execute={send} />
        )}
        {section === "Bluetooth" && (
          <HudPanel>
            <HudText kind="heading" style={{ fontSize: 17 }}>
              Bluetooth & GATT
            </HudText>
            <HudText muted>
              Editing service UUIDs affects the next explicit connection.
            </HudText>
            {Platform.OS === "web" && (
              <>
                <Field compact
                  label="Containing service UUIDs (comma separated)"
                  value={services}
                  onChange={setServices}
                />
                <HudButton
                  label="Save service UUID settings"
                  caution
                  onPress={async () => {
                    try {
                    const list = services.split(/[\s,]+/).filter(Boolean);
                    if (
                      !list.length ||
                      list.some(
                        (value) =>
                          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                            value,
                          ),
                      )
                    ) {
                      onMessage("Enter valid full service UUIDs.");
                      return;
                    }
                    await port.savePreference("services", services);
                    onMessage(
                      "Service UUIDs saved for the next explicit connection.",
                    );
                    } catch(error) { onMessage(String(error)); }
                  }}
                />
              </>
            )}
            <HudText selectable kind="mono">
              {snapshot.detail}
            </HudText>
            <HudText muted>
              Service discovery is managed by the active transport. Recent
              packet evidence is available under Service & capabilities.
            </HudText>
          </HudPanel>
        )}
        {section === "Firmware" && <Unavailable />}
      </HudPage>
    </View>
  );
}
const s = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
    alignItems: "center",
  },
});
