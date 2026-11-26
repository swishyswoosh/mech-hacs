import {useAppActive} from "../platform/useAppActive.ts";
import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import { inputTheme } from "../theme/appearance.ts";
import { HudPage } from "../components/HudPage.tsx";
import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Pressable,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  Platform,
  ScrollView,
} from "react-native";
import type { ControllerSession } from "../session/ControllerSession.ts";
import { usePreferenceRevision } from "../session/hooks.ts";
import { readOptionalPreference } from "../library/optionalPreference.ts";
import { commands, requiresMotionArm } from "../../core/index.ts";
import type { Command } from "../../core/index.ts";
import { HudPanel, HudButton } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { libraryPage } from "../library/libraryPage.ts";
import { RainbowAnimation } from "../library/rainbow.ts";
import { LibraryPlayback } from "../library/playback.ts";
import {
  libraryItems,
  libraryItem,
  searchLibrary,
  loadFavorites,
} from "../library/catalog.ts";
import type { LibraryItem } from "../library/catalog.ts";
import {
  loadHudPreferences,
  saveHudPreferences,
  pinSoundboard,
} from "../library/preferences.ts";
import type { HudPreferences } from "../library/preferences.ts";
export function Library({
  session,
  ready,
  execute,
  notify,
  initialKind = "sounds",
  pinSlot,
  onHudChanged,
  onHome,
}: {
  session: ControllerSession;
  ready: boolean;
  execute: (command: Command) => Promise<unknown>;
  notify: (text: string) => void;
  initialKind?: "sounds" | "animations";
  pinSlot?: number;
  onHudChanged?: (prefs: HudPreferences) => void;
  onHome?: () => void;
}) {
  const active = useAppActive();
  const colors = useColors();
  const s = useThemedStyles(make_s);
  const { inputPalette, inputSurface } = inputTheme(colors);

  const kind = initialKind;
  const { width, height } = useWindowDimensions();
  const nativeLandscape = Platform.OS === "android" && width > height;
  const [page, setPage] = useState(0),
    [selectedKey, setSelectedKey] = useState("");
  const [slot, setSlot] = useState(pinSlot ?? 0);
  const [favoriteSaving, setFavoriteSaving] = useState(false);
  const favoritePending = useRef(false);
  const [pinSaving, setPinSaving] = useState(false);
  const pinPending = useRef(false);
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("All"),
    [favoriteOnly, setFavoriteOnly] = useState(false);
  const [favoriteRead, setFavoriteRead] = useState(() =>
    readOptionalPreference(session, "libraryFavorites", "library favorites"),
  );
  const [favorites, setFavorites] = useState(() =>
      loadFavorites(favoriteRead.value),
    ),
    [busy, setBusy] = useState(false),
    [hud, setHud] = useState(() => loadHudPreferences(session));
  const [playback] = useState(() => new LibraryPlayback()),
    [, refresh] = useState(0),
    [clock, setClock] = useState(Date.now());
  const [rainbowRunning, setRainbowRunning] = useState(false);
  const [rainbow] = useState(() => new RainbowAnimation(session, setRainbowRunning));
  useEffect(() => () => rainbow.cancel(), [rainbow]);
  useEffect(() => { if (!ready) rainbow.cancel(); }, [ready, rainbow]);
  const preferenceRevision = usePreferenceRevision(session);
  useEffect(() => {
    const read = readOptionalPreference(
      session,
      "libraryFavorites",
      "library favorites",
    );
    setFavoriteRead(read);
    setFavorites(loadFavorites(read.value));
    setHud(loadHudPreferences(session));
  }, [session, preferenceRevision]);
  useEffect(
    () =>
      session.subscribeEvents((event) => {
        if (playback.accept(event)) refresh((n) => n + 1);
      }),
    [session, playback],
  );
  useEffect(
    () =>
      session.registerCancel(() => {
        playback.interrupt();
        refresh((n) => n + 1);
      }),
    [session, playback],
  );
  useEffect(() => {
    if (!ready) {
      playback.interrupt();
      refresh((n) => n + 1);
    }
  }, [ready, playback]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  const state = playback.state;
  const visible = searchLibrary({
    kind,
    category,
    query,
    favorites,
    favoritesOnly: favoriteOnly,
  });
  const catalogPage = libraryPage(
    visible,
    page,
    selectedKey,
    nativeLandscape ? 9 : 6,
  );
  const detail = catalogPage.selected;
  const resetPage = () => {
    setPage(0);
    setSelectedKey("");
  };
  const categories = [
    "All",
    ...new Set(
      libraryItems
        .filter(
          (item) => item.kind === (kind === "sounds" ? "sound" : "animation"),
        )
        .map((item) => item.category),
    ),
  ];
  const play = async (item?: LibraryItem, stop?: "animation" | "audio") => {
    if (!ready || busy) return;
    if (item?.lightEffect === "rainbow") {
      if (rainbowRunning) return;
      playback.interrupt();
      void rainbow.start().catch(error => notify(String(error)));
      return;
    }
    rainbow.cancel();
    setBusy(true);
    try {
      const command = item
        ? item.kind === "sound"
          ? commands.audio(item.sector!)
          : commands.animation(item.id)
        : stop === "animation"
          ? commands.stopAnimation()
          : commands.stopAudio();
      session.assertManualSource(command);
      if (requiresMotionArm(command)) session.armMotion();
      await execute(command);
    } catch (error) {
      notify(String(error));
    } finally {
      setBusy(false);
    }
  };
  const favorite = async (key: string) => {
    if (favoritePending.current) return;
    favoritePending.current = true;
    setFavoriteSaving(true);
    try {
      const read = readOptionalPreference(
        session,
        "libraryFavorites",
        "library favorites",
      );
      if (read.error) throw new Error(read.error);
      const current = loadFavorites(read.value);
      const next = current.includes(key)
        ? current.filter((old) => old !== key)
        : [...current, key];
      await session.savePreference("libraryFavorites", JSON.stringify(next));
      const saved = readOptionalPreference(
        session,
        "libraryFavorites",
        "library favorites",
      );
      setFavoriteRead(saved);
      setFavorites(loadFavorites(saved.value));
    } catch (error) {
      notify(String(error));
    } finally {
      favoritePending.current = false;
      setFavoriteSaving(false);
    }
  };
  const pin = async (slot: number, item: LibraryItem) => {
    if (pinPending.current) return;
    pinPending.current = true;
    setPinSaving(true);
    try {
      const next = pinSoundboard(loadHudPreferences(session), slot, item.key);
      await saveHudPreferences(session, next);
      const saved = loadHudPreferences(session);
      setHud(saved);
      onHudChanged?.(saved);
      notify(`${item.name} pinned to slot ${slot + 1}.`);
    } catch (error) {
      notify(String(error));
    } finally {
      pinPending.current = false;
      setPinSaving(false);
    }
  };
  const categoryChoices = categories.map((name) => (
    <Pressable
      key={name}
      accessibilityRole="button"
      accessibilityLabel={`Category ${name}`}
      accessibilityState={{ selected: category === name }}
      onPress={() => {
        setCategory(name);
        resetPage();
      }}
      style={[
        s.chip,
        nativeLandscape && { minHeight: 28 },
        { backgroundColor: category === name ? colors.primary : colors.panel },
      ]}
    >
      <HudText
        style={{
          fontSize: 12,
          color: category === name ? colors.onPrimary : colors.text,
        }}
      >
        {name}
      </HudText>
    </Pressable>
  ));
  return (
    <HudPage
      contentContainerStyle={{
        padding: nativeLandscape ? 8 : 16,
        paddingBottom: nativeLandscape ? 8 : 16,
        gap: nativeLandscape ? 4 : 10,
      }}
    >
      {!!favoriteRead.error && (
        <HudText accessibilityRole="alert" style={{ fontSize: 12 }}>
          {favoriteRead.error}
        </HudText>
      )}
      {!nativeLandscape && (
        <View style={s.row}>
          <HudText
            kind="heading"
            style={{ fontSize: 22, color: colors.primary, flex: 1 }}
          >
            {kind === "sounds" ? "Sounds" : "Animations"}
          </HudText>
          <HudText muted style={{ fontSize: 12 }}>
            {visible.length} items{ready ? "" : " · browse offline"}
          </HudText>
          {onHome && (
            <HudButton
              label="Home"
              onPress={onHome}
              style={[
                s.smallButton,
                nativeLandscape && { minHeight: 24, paddingVertical: 2 },
              ]}
            />
          )}
        </View>
      )}
      <View
        style={{
          flexDirection: width >= 900 || nativeLandscape ? "row" : "column",
          gap: nativeLandscape ? 10 : 16,
          alignItems: "stretch",
        }}
      >
        <View
          style={{
            flex: nativeLandscape ? 1.8 : 1,
            minWidth: 0,
            gap: nativeLandscape ? 4 : 10,
          }}
        >
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <TextInput
              nativeID="hud-library-search"
              accessibilityLabel="Search library"
              placeholder="Search library"
              value={query}
              onChangeText={(value) => {
                setQuery(value);
                resetPage();
              }}
              autoCapitalize="none"
              cursorColor={inputPalette.caret}
              selectionColor={inputPalette.selection}
              placeholderTextColor={inputPalette.placeholder}
              style={[
                s.search,
                nativeLandscape && {
                  minHeight: 32,
                  height: 32,
                  paddingVertical: 4,
                },
              ]}
            />
            <HudButton
              primary={favoriteOnly}
              label={favoriteOnly ? "All items" : "Favorites"}
              onPress={() => {
                setFavoriteOnly(!favoriteOnly);
                resetPage();
              }}
              style={[
                s.smallButton,
                {
                  minHeight: nativeLandscape ? 32 : 40,
                  height: nativeLandscape ? 32 : 40,
                },
              ]}
            />
          </View>
          {nativeLandscape ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0 }}
              contentContainerStyle={[s.categories, { flexWrap: "nowrap" }]}
              accessibilityLabel="Library categories"
            >
              {categoryChoices}
            </ScrollView>
          ) : (
            <View style={s.categories} accessibilityLabel="Library categories">
              {categoryChoices}
            </View>
          )}
          <View
            style={[s.grid, nativeLandscape && { gap: 4 }]}
            accessibilityLabel="Library choices"
          >
            {catalogPage.items.map((item) => (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                accessibilityLabel={`Select ${item.name}`}
                accessibilityState={{ selected: detail?.key === item.key }}
                onPress={() => setSelectedKey(item.key)}
                style={[
                  s.choice,
                  nativeLandscape && {
                    width: "30%",
                    flexGrow: 0,
                    minHeight: 28,
                    height: 28,
                    paddingVertical: 1,
                    paddingHorizontal: 4,
                    gap: 0,
                    justifyContent: "center",
                  },
                  {
                    borderColor:
                      detail?.key === item.key ? colors.primary : colors.line,
                    backgroundColor:
                      detail?.key === item.key
                        ? colors.panelRaised
                        : colors.panel,
                  },
                ]}
              >
                <HudText
                  kind="heading"
                  numberOfLines={2}
                  style={{
                    fontSize: nativeLandscape ? 12 : 16,
                    ...(nativeLandscape
                      ? { letterSpacing: 0.5, lineHeight: 13 }
                      : {}),
                  }}
                >
                  {item.name}
                  {nativeLandscape && favorites.includes(item.key) ? " ★" : ""}
                </HudText>
                {!nativeLandscape && (
                  <HudText muted style={{ fontSize: 11 }}>
                    {item.category}
                    {favorites.includes(item.key) ? " · ★" : ""}
                  </HudText>
                )}
              </Pressable>
            ))}
            {!visible.length && (
              <HudText muted>
                No matching items. Try another category or search.
              </HudText>
            )}
          </View>
          <View style={[s.row, { justifyContent: "space-between" }]}>
            <HudButton
              label="Previous page"
              disabled={catalogPage.page === 0}
              style={[
                s.smallButton,
                nativeLandscape && { minHeight: 24, paddingVertical: 2 },
              ]}
              onPress={() => {
                setPage(catalogPage.page - 1);
                setSelectedKey("");
              }}
            />
            <HudText kind="mono" style={{ fontSize: 12 }}>
              {catalogPage.pages
                ? `${catalogPage.page + 1} / ${catalogPage.pages}`
                : "0 / 0"}
            </HudText>
            <HudButton
              label="Next page"
              disabled={
                !catalogPage.pages || catalogPage.page === catalogPage.pages - 1
              }
              style={[
                s.smallButton,
                nativeLandscape && { minHeight: 24, paddingVertical: 2 },
              ]}
              onPress={() => {
                setPage(catalogPage.page + 1);
                setSelectedKey("");
              }}
            />
          </View>
        </View>
        <HudPanel
          style={[s.details, nativeLandscape && { padding: 6, gap: 2 }]}
          accessibilityLabel="Selected library item"
        >
          {detail ? (
            <>
              <HudText
                kind="heading"
                numberOfLines={2}
                style={{
                  fontSize: nativeLandscape ? 16 : 22,
                  ...(nativeLandscape ? { lineHeight: 18 } : {}),
                  color: colors.primary,
                }}
              >
                {detail.name}
              </HudText>
              <View style={s.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Play ${detail.name}`}
                  accessibilityState={{ disabled: !ready || busy || (!!detail.lightEffect && rainbowRunning) }}
                  disabled={!ready || busy || (!!detail.lightEffect && rainbowRunning)}
                  onPress={() => void play(detail)}
                  style={({ pressed }) => [
                    s.play,
                    nativeLandscape && {
                      minHeight: 32,
                      paddingVertical: 2,
                      paddingHorizontal: 8,
                    },
                    { opacity: !ready || busy ? 0.45 : pressed ? 0.7 : 1 },
                  ]}
                >
                  <HudText
                    kind="heading"
                    style={{
                      fontSize: nativeLandscape ? 12 : 16,
                      color: colors.onPrimary,
                    }}
                  >
                    Play
                  </HudText>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${favorites.includes(detail.key) ? "Unfavorite" : "Favorite"} ${detail.name}`}
                  accessibilityState={{
                    selected: favorites.includes(detail.key),
                    disabled: favoriteSaving,
                  }}
                  disabled={favoriteSaving}
                  onPress={() => favorite(detail.key)}
                  style={({ pressed }) => [
                    s.favorite,
                    nativeLandscape && {
                      minHeight: 32,
                      paddingVertical: 2,
                      paddingHorizontal: 8,
                    },
                    { opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <HudText
                    kind="heading"
                    style={{
                      fontSize: nativeLandscape ? 12 : 16,
                      color: colors.primary,
                    }}
                  >
                    {favorites.includes(detail.key)
                      ? "★ Favorited"
                      : "☆ Favorite"}
                  </HudText>
                </Pressable>
              </View>
              {detail.lightEffect ? (
                <HudText muted style={{fontSize:12}}>
                  {rainbowRunning ? "Rainbow running · Stop animation to end" : "Dome lights · repeats until stopped"}
                </HudText>
              ) : <View style={{ gap: nativeLandscape ? 2 : 6 }}>
                <HudText
                  kind="heading"
                  style={{
                    fontSize: 13,
                    ...(nativeLandscape ? { lineHeight: 16 } : {}),
                  }}
                >
                  COCKPIT BUTTON
                </HudText>
                <View style={[s.categories, nativeLandscape && { gap: 2 }]}>
                  {hud.soundboard.map((key, index) => (
                    <Pressable
                      key={index}
                      accessibilityRole="button"
                      accessibilityLabel={`Soundboard slot ${index + 1}: ${key ? libraryItem(key)?.name || "Empty" : "Empty"}`}
                      accessibilityState={{ selected: slot === index }}
                      onPress={() => setSlot(index)}
                      style={[
                        s.slot,
                        nativeLandscape && { minWidth: 24, minHeight: 28 },
                        {
                          backgroundColor:
                            slot === index ? colors.primary : colors.panel,
                        },
                      ]}
                    >
                      <HudText
                        kind="mono"
                        style={{
                          fontSize: 12,
                          color:
                            slot === index ? colors.onPrimary : colors.text,
                        }}
                      >
                        {index + 1}
                      </HudText>
                    </Pressable>
                  ))}
                </View>
                <HudText muted style={{ fontSize: 12 }}>
                  Current:{" "}
                  {hud.soundboard[slot]
                    ? libraryItem(hud.soundboard[slot]!)?.name || "Empty"
                    : "Empty"}
                </HudText>
                <HudButton
                  label={`Save to cockpit button ${slot + 1}`}
                  disabled={pinSaving}
                  onPress={() => pin(slot, detail)}
                  style={[
                    s.smallButton,
                    nativeLandscape && { minHeight: 24, paddingVertical: 2 },
                  ]}
                />
              </View>}
            </>
          ) : (
            <HudText muted>
              Select a matching item to play or customize a cockpit button.
            </HudText>
          )}
          <View
            style={[s.row, nativeLandscape && { flexWrap: "nowrap", gap: 4 }]}
          >
            {kind === "animations" && (
              <HudButton
                label="Stop animation"
                disabled={!ready || busy}
                style={[
                  s.smallButton,
                  nativeLandscape && {
                    minHeight: 24,
                    paddingVertical: 2,
                    paddingHorizontal: 4,
                    flex: 1,
                    minWidth: 0,
                  },
                ]}
                onPress={() => void play(undefined, "animation")}
              />
            )}
            <HudButton
              label="Stop all audio"
              disabled={!ready || busy}
              style={[
                s.smallButton,
                nativeLandscape && {
                  minHeight: 24,
                  paddingVertical: 2,
                  paddingHorizontal: 4,
                  flex: 1,
                  minWidth: 0,
                },
              ]}
              onPress={() => void play(undefined, "audio")}
            />
          </View>
          {state && !(Platform.OS === "android" && kind === "sounds") && (
            <View accessibilityLiveRegion="polite" style={{ gap: 3 }}>
              <HudText style={{ fontSize: 12 }}>
                {state.name} ·{" "}
                {state.status === "requested"
                  ? "Awaiting acknowledgement"
                  : state.status === "acknowledged"
                    ? "Command acknowledged · completion unknown"
                    : state.status === "stop-acknowledged"
                      ? "Scoped stop acknowledged"
                      : state.status === "interrupted"
                        ? "Interrupted locally"
                        : `Command failed: ${state.error || "unknown error"}`}
              </HudText>
              {state.status === "acknowledged" && (
                <HudText kind="mono" muted style={{ fontSize: 11 }}>
                  Elapsed {(playback.elapsed(clock) / 1000).toFixed(1)} s
                </HudText>
              )}
            </View>
          )}
        </HudPanel>
      </View>
    </HudPage>
  );
}
const make_s = (colors: Palette) => {
  const { inputSurface } = inputTheme(colors);
  return StyleSheet.create({
    search: {
      ...inputSurface,
      flex: 1,
      minWidth: 0,
      minHeight: 40,
      height: 40,
      padding: 8,
      fontSize: 14,
      borderWidth: 1,
      borderColor: colors.line2,
      borderRadius: 4,
    },
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      alignItems: "center",
    },
    categories: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
    chip: {
      minHeight: 30,
      paddingHorizontal: 9,
      borderRadius: 6,
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.line,
    },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    choice: {
      width: "47%",
      flexGrow: 1,
      minHeight: 56,
      padding: 8,
      gap: 3,
      borderWidth: 1,
      borderRadius: 8,
    },
    details: { flex: 1, minWidth: 0, padding: 14, gap: 10 },
    play: {
      flex: 1,
      minHeight: 44,
      padding: 8,
      backgroundColor: colors.primary,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    favorite: {
      minHeight: 44,
      padding: 8,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    smallButton: { minHeight: 34, paddingVertical: 5, paddingHorizontal: 10 },
    slot: {
      minWidth: 32,
      minHeight: 32,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.line,
    },
  });
};
