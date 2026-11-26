import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { ControllerSession } from "../session/ControllerSession.ts";
import { Field } from "../library/Fields.tsx";
import { HudButton } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { readOptionalPreference } from "../library/optionalPreference.ts";
import { usePreferenceRevision } from "../session/hooks.ts";

/** Friendly names are display preferences; BLE identity and connection stay unchanged. */
export function DroidName({
  session,
  identity,
  defaultName,
}: {
  session: ControllerSession;
  identity: string;
  defaultName: string;
}) {
  const preferenceKey = `droidName.v1.${encodeURIComponent(identity)}`;
  const [initial] = useState(() =>
    readOptionalPreference(session, preferenceKey, "droid name"),
  );
  const [saved, setSaved] = useState(initial.value);
  const [draft, setDraft] = useState(saved ?? "");
  const [editing, setEditing] = useState(saved === null);
  const [error, setError] = useState(initial.error ?? "");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const preferenceRevision = usePreferenceRevision(session);
  useEffect(() => {
    const current = readOptionalPreference(
      session,
      preferenceKey,
      "droid name",
    );
    setSaved(current.value);
    setError(current.error ?? "");
  }, [session, preferenceKey, preferenceRevision]);
  const save = async () => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    const name = draft.trim();
    try {
      await session.savePreference(preferenceKey, name);
      const current = readOptionalPreference(
        session,
        preferenceKey,
        "droid name",
      );
      setSaved(current.value);
      if (latestDraft.current === draft) {
        setDraft(name);
        setEditing(false);
      }
      setError(current.error ?? "");
    } catch (e) {
      setError(String(e));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <View style={{ alignSelf: "center", width: "100%", maxWidth: 360, gap: 4, paddingBottom: editing ? 16 : 0 }}>
      {editing ? (
        <>
          <View
            style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}
          >
            <View style={{ flex: 1 }}>
              <Field
                id="droid-friendly-name"
                label="Droid name"
                hideLabel
                placeholder={defaultName}
                compact
                value={draft}
                onChangeText={setDraft}
                maxLength={40}
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={save}
              />
            </View>
            <HudButton
              label="Save name"
              disabled={saving}
              onPress={save}
              style={{
                minHeight: 36,
                paddingHorizontal: 10,
                paddingVertical: 6,
              }}
            />
          </View>
        </>
      ) : (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            gap: 8,
          }}
        >
          <HudText kind="heading" style={{ fontSize: 22, flexShrink: 1 }}>
            {saved || defaultName}
          </HudText>
          <HudButton
            label="Rename"
            onPress={() => {
              setDraft(saved ?? "");
              setEditing(true);
            }}
            style={{ minHeight: 32, paddingHorizontal: 8, paddingVertical: 4 }}
          />
        </View>
      )}
      {error ? <HudText accessibilityRole="alert">{error}</HudText> : null}
    </View>
  );
}
