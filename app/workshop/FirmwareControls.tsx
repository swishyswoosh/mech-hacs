import React, {useEffect, useState} from 'react';
import {View} from 'react-native';
import {HudPanel} from '../components/Hud.tsx';
import {HudText} from '../theme/Theme.tsx';
import {CompactButton} from './Controls.tsx';
import {recoveredCommands, decodeRecoveredReadback} from '../../core/recoveredControls.ts';
import {notificationText} from '../../core/notifications.ts';
import type {Command, Packet} from '../../core/protocol.ts';
import type {AppPort} from '../session/types.ts';
const reads = [
  ['Trophy mode', recoveredCommands.getTrophyMode],
  ['Droid interaction', recoveredCommands.getDroidInteractionMode]
] as const;
const registrations = [
  ['Play mode', recoveredCommands.enablePlayModeNotifications],
  ['Gyro maximum', recoveredCommands.gyroMaxNotifications],
  ['Accelerometer activity', recoveredCommands.accelerometerActivityNotifications],
  ['Gyro activity', recoveredCommands.gyroActivityNotifications]
] as const;
export function FirmwareControls({
  port,
  ready,
  connectionEpoch,
  execute
}: {
  port: AppPort;
  ready: boolean;
  connectionEpoch?: number;
  execute: (command: Command) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [values, setValues] = useState<Record<string, {text: string; epoch?: number}>>({}),
    [events, setEvents] = useState<string[]>([]);
  useEffect(
    () =>
      port.subscribeEvents?.((event) => {
        if (
          event.type === 'notification' &&
          ['play-mode-changed', 'gyro-max', 'accelerometer-activity', 'gyro-activity'].includes(
            event.notification.type
          )
        )
          setEvents((old) => [notificationText(event.notification), ...old].slice(0, 6));
      }),
    [port]
  );
  const readPlayMode = async () => {
    setBusy(true);
    try {
      if (!port.readPlayMode) throw new Error('Play-mode reader unavailable');
      const mode = await port.readPlayMode();
      setValues((old) => ({...old, 'Play mode': {text: `Mode ${mode}`, epoch: connectionEpoch}}));
      setMessage('Play mode read.');
    } catch (error) {
      setMessage(`Play mode: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  const request = async (label: string, command: Command, read = false) => {
    setBusy(true);
    try {
      const packet = await execute(command);
      if (read) {
        const value = decodeRecoveredReadback(packet as Packet);
        if (!value) throw new Error('Unexpected mode response payload');
        setValues((old) => ({
          ...old,
          [label]: {
            epoch: connectionEpoch,
            text: value.type === 'play-mode'
              ? `Mode ${value.mode}`
              : value.enabled
                ? 'Enabled'
                : 'Disabled'
          }
        }));
      }
      setMessage(`${label}: acknowledged.`);
    } catch (error) {
      setMessage(`${label}: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{gap: 8}}>
      <HudPanel style={{padding: 10, gap: 8}}>
        <HudText kind="heading" style={{fontSize: 17}}>
          Mode readbacks
        </HudText>
        <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 6}}>
          <CompactButton
            label="Read play mode"
            disabled={!ready || busy}
            onPress={() => void readPlayMode()}
          />
          {reads.map(([label, build]) => (
            <CompactButton
              key={label}
              label={`Read ${label.toLowerCase()}`}
              disabled={!ready || busy}
              onPress={() => void request(label, build(), true)}
            />
          ))}
        </View>
        {Object.entries(values).map(([label, value]) => (
          <HudText key={label} style={{fontSize: 13}}>
            {label} · {value.text}
            {!ready || value.epoch !== connectionEpoch ? ' · stale' : ''}
          </HudText>
        ))}
      </HudPanel>
      <HudPanel style={{padding: 10, gap: 8}}>
        <HudText kind="heading" style={{fontSize: 17}}>
          Event notifications
        </HudText>
        {registrations.map(([label, build]) => (
          <View
            key={label}
            style={{flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6}}
          >
            <HudText style={{fontSize: 13, flex: 1, minWidth: 145}}>{label}</HudText>
            <View style={{flexDirection: 'row', gap: 6}}>
              <CompactButton
                label={`Enable ${label.toLowerCase()} events`}
                text="Enable"
                disabled={!ready || busy}
                onPress={() => void request(`${label} enabled`, build(true))}
              />
              <CompactButton
                label={`Disable ${label.toLowerCase()} events`}
                text="Disable"
                disabled={!ready || busy}
                onPress={() => void request(`${label} disabled`, build(false))}
              />
            </View>
          </View>
        ))}
        {events.map((event, index) => (
          <HudText key={index} kind="mono" style={{fontSize: 11}}>
            {event}
          </HudText>
        ))}
      </HudPanel>
      {!!message && (
        <HudText accessibilityLiveRegion="polite" style={{fontSize: 13}}>
          {message}
        </HudText>
      )}
    </View>
  );
}
