import {useEffect, useState} from "react";
import {AppState, Platform} from "react-native";

/** UI work follows visibility; transport safety remains owned by the session. */
export function useAppActive() {
  const [active, setActive] = useState(() => Platform.OS === "web"
    ? typeof document === "undefined" || !document.hidden
    : AppState.currentState === "active");
  useEffect(() => {
    if (Platform.OS === "web") {
      const changed = () => setActive(!document.hidden);
      document.addEventListener("visibilitychange", changed);
      changed();
      return () => document.removeEventListener("visibilitychange", changed);
    }
    const subscription = AppState.addEventListener("change", state => setActive(state === "active"));
    setActive(AppState.currentState === "active");
    return () => subscription.remove();
  }, []);
  return active;
}
