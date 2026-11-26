import {registerControllerPwa} from "./pwa.ts";
/// <reference types="vite/client" />
import React from "react";
import { createRoot } from "react-dom/client";
import { ControllerApp } from "../app/App.tsx";
import type {ControllerSession} from "../app/session/ControllerSession.ts";
import {RemoteApp} from "./RemoteApp.tsx";
import "./style.css";
import "../app/theme/hud.css";
const homeAssistantMode=new URLSearchParams(location.search).get("ha")==="1";
const remoteMode=homeAssistantMode || new URLSearchParams(location.search).get("remote") === "1" || document.querySelector('meta[name="mech-session"]')?.getAttribute("content") === "remote";
if(!remoteMode)registerControllerPwa();
const root =
  import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
const remotePort = remoteMode ? (await import("./remoteRuntime.ts")).port : undefined;
const port:ControllerSession = remotePort ?? (await import("./runtime.ts")).port;
const render=(ControllerComponent=ControllerApp)=>root.render(remotePort ? <RemoteApp port={remotePort} ControllerComponent={ControllerComponent} homeAssistant={homeAssistantMode}/> : <ControllerComponent port={port}/>);
render();
if (import.meta.hot) {
  import.meta.hot.data.root = root;
  import.meta.hot.dispose(() => port.handleWindowBlur(true));
  // A UI edit replaces only the rendered view. The connection owner and this
  // entry module stay alive; runtime.ts pauses control before the update.
  import.meta.hot.accept("../app/App.tsx", (updated) => {
    if (updated) render(updated.ControllerApp);
  });
  import.meta.hot.accept();
}
