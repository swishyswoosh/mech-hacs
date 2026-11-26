import { AppearanceContext, useColors } from "../theme/useColors.ts";
import { darkPalette, lightPalette } from "../theme/palettes.ts";
import { installHomeBack } from "./BrowserBack.ts";
import { emptyFigure, figureState } from "../components/FigureState.ts";

import { HubSheet } from "./HubSheet.tsx";
import { HudHeader, titles } from "./HudHeader.tsx";
import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  View,
  ScrollView,
  BackHandler,
  Platform,
  useWindowDimensions,
  Pressable,
} from "react-native";
import type { ControllerSession } from "../session/ControllerSession.ts";
import { useSessionSnapshot } from "../session/hooks.ts";
import { Navigator, destinations } from "./Navigator.ts";
import type { Route, Destination } from "./Navigator.ts";
import type { PauseGate } from "./PauseGate.ts";
import { leaveDiagnostics } from "./serviceNavigation.ts";
import { HudTheme, HudText, useMotion } from "../theme/Theme.tsx";
import {
  HudButton,
  HudPanel,
  StatusPill,
  StopButton,
} from "../components/Hud.tsx";
import { Icon } from "../components/Icon.tsx";
import { Starfield } from "../components/Space.tsx";
import { Sheet, Toast } from "../components/Overlays.tsx";
import { Launch } from "../screens/Launch.tsx";
import { Home } from "../screens/Home.tsx";
import { NativeSlider } from "../platform/NativeInputs";
import {readOptionalPreference} from '../library/optionalPreference.ts';
export type ScreenContext = {
  route: Route;
  navigationVersion: number;
  ready: boolean;
  navigate: (route: Route) => void;
  notify: (text: string) => void;
  depot: boolean;
  setDepot: (value: boolean) => void;
  intensity: boolean;
  setIntensity: (value: boolean) => void;
  onSafety: () => void;
};
type Props = {
  session: ControllerSession;
  pause: PauseGate;
  appearance: "light" | "dark";
  onAppearance: (value: "light" | "dark") => void;
  largeLabels: boolean;
  message: string;
  onClearMessage: () => void;
  children: (context: ScreenContext) => React.ReactNode;
  beforeNavigate: () => Promise<void>;
  onStop: () => void;
};
export function ControllerShell(props: Props) {
  const [intensityRead] = useState(() => readOptionalPreference(props.session, 'hudIntensity', 'theme effects'));
  const [intensity, setIntensity] = useState(
    () => intensityRead.value !== "off",
  );
  return (
    <AppearanceContext.Provider value={props.appearance}>
    <HudTheme.Provider value={{ largeLabels: props.largeLabels, intensity }}>
      <Shell {...props} preferenceError={intensityRead.error} intensity={intensity} setIntensity={setIntensity} />
    </HudTheme.Provider>
    </AppearanceContext.Provider>
  );
}
function Shell({
  session,
  pause,
  largeLabels,
  appearance,
  onAppearance,
  message,
  onClearMessage,
  children,
  beforeNavigate,
  onStop,
  intensity,
  setIntensity,
  preferenceError,
}: Props & { intensity: boolean; setIntensity: (value: boolean) => void; preferenceError?: string }) {
  const colors = useColors();

  const [figure, setFigure] = useState(emptyFigure);
  useEffect(() => session.registerCancel(() => {
    setFigure(old => old.stance === "waddle" ? {...old, stance: undefined} : old);
  }), [session]);
  useEffect(
    () =>
      session.subscribeEvents((event) =>
        setFigure((old) => figureState(old, event)),
      ),
    [session],
  );
  const snapshot = useSessionSnapshot(session),
    { width, height } = useWindowDimensions(),
    motion = useMotion();
  const [homeHeight, setHomeHeight] = useState(height);
  const homeScroll = useRef<React.ElementRef<typeof ScrollView>>(null);
  const current = useRef({ beforeNavigate });
  current.current = { beforeNavigate };
  const [navigator] = useState(
    () =>
      new Navigator({
        release: () => current.current.beforeNavigate(),
        leaveService: () => leaveDiagnostics(session),
      }),
  );
  const route = useSyncExternalStore(
    navigator.subscribe,
    navigator.getSnapshot,
    navigator.getSnapshot,
  );
  const paused = useSyncExternalStore(
    pause.subscribe,
    pause.getSnapshot,
    pause.getSnapshot,
  );
  const [depotRead] = useState(() => readOptionalPreference(session, 'depotEnabled', 'Depot visibility'));
  const [depot, setDepot] = useState(
    () => depotRead.value === "true",
  );
  const [sheet, setSheet] = useState<
      "notes" | "dome" | "stance" | "safety" | "conflict" | null
    >(null),
    [notes, setNotes] = useState<string[]>([]),
    [toast, setToast] = useState(""),
    [actionBusy, setActionBusy] = useState(false),
    [switching, setSwitching] = useState(false);
  const navigationPending = useRef(false);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const notify = (text: string) => {
    if (!text) return;
    setNotes((old) => (old[0] === text ? old : [text, ...old].slice(0, 50)));
    setToast(text);
    if (
      text.includes("ResourceConflictError") ||
      text.includes("Stop/replace required")
    )
      setSheet("conflict");
  };
  const latest = useRef({ notify, onStop, route, sheet });
  latest.current = { notify, onStop, route, sheet };
  const navigate = (next: Route) => {
    setToast("");
    if (navigationPending.current) return;
    navigationPending.current = true;
    setSwitching(true);
    setSheet(null);
    homeScroll.current?.scrollTo({ y: 0, animated: false });
    void navigator.go(next).then(changed => {
      if (changed) setNavigationVersion(version => version + 1);
    }).catch((error) => notify(String(error))).finally(() => {
      navigationPending.current = false;
      setSwitching(false);
    });
  };
  useEffect(() => {
    const observe = () => {
      const s = session.store.getSnapshot();
      navigator.connection(s.state, s.connection.epoch);
    };
    observe();
    return session.store.subscribe(observe);
  }, [session, navigator]);
  useEffect(() => {
    if (message) latest.current.notify(message);
  }, [message]);
  useEffect(() => {
    if (snapshot.state === "failed") notify(snapshot.detail);
  }, [snapshot.state, snapshot.detail]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    document.documentElement.dataset.hudMotion = motion ? "on" : "off";
    document.documentElement.dataset.r2Theme = appearance;
    const palette = appearance === "light" ? lightPalette : darkPalette;
    for (const [key, value] of Object.entries(palette))
      document.documentElement.style.setProperty(`--r2-${key}`, value);
    document.documentElement.style.colorScheme = appearance;
  }, [motion, appearance]);
  useEffect(() => {
    if (Platform.OS === "web") {
      const key = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement;
        if (
          event.key !== "Escape" &&
          target.closest('input,textarea,select,[contenteditable="true"]')
        )
          return;
        if (
          event.key === "Escape" ||
          (event.code === "Space" &&
            (target === document.body || target === document.documentElement))
        ) {
          if (latest.current.route === "cockpit" && event.key !== "Escape")
            return;
          event.preventDefault();
          latest.current.onStop();
        } else if (
          latest.current.route !== "cockpit" &&
          event.key.toLowerCase() === "h" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          navigate("home");
        }
      };
      window.addEventListener("keydown", key);
      const removeBack = installHomeBack(window, () => navigate("home"));
      return () => {
        window.removeEventListener("keydown", key);
        removeBack();
      };
    }
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (latest.current.sheet) {
        setSheet(null);
        return true;
      }
      if (latest.current.route === "home" || latest.current.route === "launch")
        return false;
      navigate("home");
      return true;
    });
    return () => back.remove();
  }, [navigator]);
  const action = async (work: () => Promise<unknown>) => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await work();
    } catch (error) {
      if (error instanceof Error && error.name === "ResourceConflictError")
        setSheet("conflict");
      notify(String(error));
    } finally {
      setActionBusy(false);
    }
  };
  const connected = !["disconnected", "sleeping", "awaiting-restart"].includes(
    snapshot.state,
  );
  const legacy = route !== "home" && route !== "launch";
  const canControl = snapshot.safety.canControl && !paused && !actionBusy && !switching;
  return (
    <View
      nativeID="droid-console"
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: colors.bg,
        padding: height < 600 ? 6 : width < 600 ? 8 : 24,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Starfield />
      <View
        nativeID="controller-card"
        style={{
          width: "100%",
          maxWidth: 1040,
          height: "100%",
          maxHeight: 640,
          minHeight: 0,
          borderWidth: 1,
          borderColor: colors.line2,
          borderRadius: 16,
          overflow: "hidden",
          backgroundColor: colors.bg,
        }}
      >
        <HudHeader
          session={session}
          route={route}
          snapshot={snapshot}
          paused={paused}
          depot={depot}
          notes={notes.length}
          navigate={navigate}
          onStop={onStop}
          onNotes={() => setSheet("notes")}
          appearance={appearance}
          onToggleAppearance={() =>
            onAppearance(appearance === "dark" ? "light" : "dark")
          }
        />
        {!!(preferenceError || depotRead.error) && <HudText accessibilityRole="alert" style={{fontSize: 12, paddingHorizontal: 8}}>{preferenceError || depotRead.error}</HudText>}
        <HudPanel
          nativeID="tab-panel"
          accessibilityLabel={`${titles[route]} panel`}
          active={route !== "launch"}
          style={{
            flex: 1,
            minHeight: 0,
            margin: height < 600 ? 6 : width < 600 ? 8 : 16,
            marginTop: height < 600 ? 2 : width < 600 ? 4 : 8,
            padding: 0,
            gap: 0,
            borderColor: colors.line2,
            overflow: "hidden",
          }}
        >
          {!legacy && (
            <ScrollView
              ref={homeScroll}
              onLayout={(event) => setHomeHeight(event.nativeEvent.layout.height)}
              style={{ flex: 1, display: legacy ? "none" : "flex" }}
              contentContainerStyle={{
                width: "100%",
                maxWidth: 1200,
                alignSelf: "center",
                padding:
                  height < 600 && width > height ? 8 : width < 600 ? 16 : 28,
                paddingBottom: height < 600 && width > height ? 4 : 24,
                flexGrow: 1,
                justifyContent: "center",
              }}
            >
              {route === "launch" && (
                <Launch
                  session={session}
                  snapshot={snapshot}
                  notify={notify}
                  onExplore={() => navigate("home")}
                />
              )}
              {route === "home" && (
                <Home
                  availableHeight={homeHeight - 16}
                  session={session}
                  snapshot={snapshot}
                  figure={figure}
                  onStop={onStop}
                  depot={depot}
                  onNavigate={navigate}
                  onDome={() => {
                    setSheet("dome");
                  }}
                  onStance={() => setSheet("stance")}
                />
              )}
            </ScrollView>
          )}
          {legacy && (
            <View style={{ flex: 1, minHeight: 0 }}>
              {children({
                route,
                navigationVersion,
                ready: canControl,
                navigate,
                notify,
                depot,
                setDepot: async (value) => {
                  try { await session.savePreference("depotEnabled", String(value));
                  setDepot(value); } catch(error) { notify(String(error)); }
                },
                intensity,
                setIntensity: async (value) => {
                  try { await session.savePreference("hudIntensity", value ? "on" : "off");
                  setIntensity(value); } catch(error) { notify(String(error)); }
                },
                onSafety: () => setSheet("safety"),
              })}
            </View>
          )}
        </HudPanel>
      </View>
      {!!toast && !paused && !sheet && (
        <Toast
          message={toast}
          onOpen={() => setSheet("notes")}
          onDismiss={() => setToast("")}
        />
      )}
      <HubSheet
        stance={figure.stance}
        sheet={sheet}
        setSheet={setSheet}
        onStop={onStop}
        notes={notes}
        onClearNotes={() => {
          setNotes([]);
          setToast("");
          onClearMessage();
        }}
        notify={notify}
        snapshot={snapshot}
        canControl={canControl}
        action={action}
        session={session}
      />

    </View>
  );
}
