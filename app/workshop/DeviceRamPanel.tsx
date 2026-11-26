import React, {useEffect, useRef, useState} from 'react';
import {View, Platform} from 'react-native';
import {HudPanel, HudButton} from '../components/Hud.tsx';
import {HudText} from '../theme/Theme.tsx';
import type {AppPort} from '../session/types.ts';
import {compileNordicInlineLedRecipe} from '../../core/ramRecipe.ts';
import {exampleDeviceLights, parseDeviceLightFile} from '../../core/deviceLightFiles.ts';
import type {DeviceLightFile} from '../../core/deviceLightFiles.ts';
const preference = 'device.light-recipe.v1';
export function DeviceRamPanel({port, ready}: {port: AppPort; ready: boolean}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [recipe, setRecipe] = useState(() => {
    try {
      return parseDeviceLightFile(
        port.loadPreference(preference) || JSON.stringify(exampleDeviceLights)
      );
    } catch {
      return exampleDeviceLights;
    }
  });
  const [review, setReview] = useState<DeviceLightFile>();
  const importGeneration = useRef(0);
  const saveInFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  useEffect(
    () => () => {
      importGeneration.current++;
    },
    []
  );
  const compact = {minHeight: 34, paddingVertical: 5, paddingHorizontal: 10};
  const cancelReview = () => {
    importGeneration.current++;
    setReview(undefined);
  };
  const read = async (source: () => Promise<string | undefined>) => {
    const generation = ++importGeneration.current;
    setReview(undefined);
    setMessage('');
    try {
      const text = await source();
      if (generation !== importGeneration.current) return;
      if (text === undefined) {
        setMessage('File selection canceled.');
        return;
      }
      setReview(parseDeviceLightFile(text));
      setMessage('File validated. Use it to replace the saved light protocol.');
    } catch (error) {
      if (generation === importGeneration.current) setMessage(String(error));
    }
  };
  const saveFile = async () => {
    try {
      const text = JSON.stringify(recipe, null, 2);
      if (port.exportLocalJson) await port.exportLocalJson('droid-light-protocol.json', text);
      else if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'droid-light-protocol.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else throw Error('File export unavailable');
      setMessage('Light protocol file export requested.');
    } catch (error) {
      setMessage(String(error));
    }
  };
  const run = async () => {
    setBusy(true);
    setMessage('Preparing on-droid lights…');
    try {
      if (!port.runDeviceLightRecipe) throw Error('Device-RAM execution unavailable');
      await port.runDeviceLightRecipe(recipe);
      setMessage('Light protocol ended; cancellation acknowledged.');
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  const saveReviewedRecipe = async () => {
    if (saveInFlight.current || !review) return;
    const candidate = review;
    const generation = importGeneration.current;
    saveInFlight.current = true;
    setSaving(true);
    try {
      await port.savePreference(preference, JSON.stringify(candidate));
      setRecipe(candidate);
      if (generation === importGeneration.current) {
        setReview(undefined);
        setMessage('Light protocol saved.');
      }
    } catch (error) {
      if (generation === importGeneration.current) setMessage(String(error));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <HudPanel style={{padding: 10, gap: 8}}>
      <HudButton
        style={compact}
        label={open ? 'Hide on-droid protocol' : 'On-droid protocol'}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <>
          <HudText>
            {recipe.name} · {recipe.frames.length} frames ·{' '}
            {(compileNordicInlineLedRecipe(recipe).durationMs / 1000).toFixed(1)} s
          </HudText>
          <HudText muted style={{fontSize: 12}}>
            Light frames run on the droid’s Nordic processor. Keep this controller in the
            foreground. Motion, sound and mixed actions use the local protocol below.
          </HudText>
          <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 6}}>
            <HudButton
              style={compact}
              label="Run light protocol"
              disabled={!ready || busy || !port.runDeviceLightRecipe}
              onPress={() => void run()}
            />
            <HudButton
              style={compact}
              label="Stop light protocol"
              disabled={!ready || !busy}
              onPress={() =>
                void port.stopDeviceLightRecipe?.().catch((e) => setMessage(String(e)))
              }
            />
            <HudButton
              style={compact}
              label="Save light protocol JSON file"
              disabled={busy}
              onPress={() => void saveFile()}
            />
            {port.importLocalJson && (
              <HudButton
                style={compact}
                label="Load light protocol file"
                disabled={busy}
                onPress={() => void read(() => port.importLocalJson!())}
              />
            )}
          </View>
          {Platform.OS === 'web' && (
            <View>
              {React.createElement(
                'label',
                {},
                'Load light protocol file',
                React.createElement('input', {
                  type: 'file',
                  accept: '.json,application/json',
                  'aria-label': 'Load light protocol file',
                  disabled: busy,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    const file = event.target.files?.[0];
                    void read(() => (file ? file.text() : Promise.resolve(undefined)));
                    event.target.value = '';
                  }
                })
              )}
            </View>
          )}
          {review && (
            <View style={{gap: 5}}>
              <HudText>
                Review: {review.name} · {review.frames.length} frames
              </HudText>
              <HudButton
                style={compact}
                label="Use and save this light protocol"
                disabled={busy || saving}
                onPress={() => void saveReviewedRecipe()}
              />
              <HudButton style={compact} label="Cancel file review" onPress={cancelReview} />
            </View>
          )}
          <HudText muted style={{fontSize: 11}}>
            JSON: version, name, frames. Each frame has atMs, transitionMs (80+), and controls:
            front R/G/B, rear R/G/B, projector, readouts (0–255). These are firmware animation
            controls; fades and color mixing differ from direct light settings. Export the example
            to edit. Maximum 65.5 seconds; Nordic 7.0.101 required.
          </HudText>
          {!!message && (
            <HudText accessibilityLiveRegion="polite" style={{fontSize: 12}}>
              {message}
            </HudText>
          )}
        </>
      )}
    </HudPanel>
  );
}
