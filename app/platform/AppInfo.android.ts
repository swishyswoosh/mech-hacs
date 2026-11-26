import { NativeModules, Platform } from "react-native";
import type { AppInfo } from "./AppInfo.ts";
export function getAppInfo(): AppInfo {
  const info = NativeModules.R2AppInfo?.getConstants();
  return {name: "Mech for Android", version: info?.versionName ?? "Unavailable",
    build: info?.versionCode === undefined ? undefined : String(info.versionCode),
    system: Platform.OS === "android" ? `Android ${Platform.constants.Release} · API ${Platform.Version}` : undefined};
}
