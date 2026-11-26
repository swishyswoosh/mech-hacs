import { CONTROLLER_VERSION } from "../version.ts";
export interface AppInfo { name: string; version: string; build?: string; system?: string }
declare const __MECH_APP_INFO__: AppInfo;
export function getAppInfo(): AppInfo {
  return typeof __MECH_APP_INFO__ === "undefined"
    ? {name: "Mech", version: CONTROLLER_VERSION}
    : __MECH_APP_INFO__;
}
