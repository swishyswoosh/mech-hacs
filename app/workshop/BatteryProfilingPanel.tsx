import React, {useState} from 'react';
import {Platform, View} from 'react-native';
import type {AppPort} from '../session/types.ts';
import type {BatteryProfilingSummary} from '../session/BatteryProfiling.ts';
import {HudText} from '../theme/Theme.tsx';
import {
  DepotButton as Button,
  DepotPanel as Panel,
  DepotDetails,
  depotLayout
} from './CompactLayout.tsx';
import {BatteryVoltageGraph} from './BatteryVoltageGraph.tsx';
/** Depot owns setup; collection belongs to the session. */
export function BatteryProfilingPanel({
  port,
  summary: s,
  ready
}: {
  port: AppPort;
  summary?: BatteryProfilingSummary;
  ready: boolean;
}) {
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<'full' | 'shutdown'>(),
    [selected, setSelected] = useState<string>();
  const [prepared, setPrepared] = useState<{name: string; text: string; bytes: number}>();
  const action = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage('');
    try {
      await work();
      setConfirm(undefined);
      setMessage(success);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!s || !port.armBatteryProfiling)
    return (
      <Panel>
        <HudText>Battery profiling is unavailable in this controller build.</HudText>
      </Panel>
    );
  const disabled = busy || s.pending || !!s.storageError,
    candidate = s.validation.profile,
    run = s.runs.find((r) => r.id === selected) ?? s.current ?? s.runs.at(-1);
  const save = async () => {
    if (!prepared) return;
    if (port.exportLocalJson) await port.exportLocalJson(prepared.name, prepared.text);
    else if (Platform.OS === 'web') {
      const url = URL.createObjectURL(new Blob([prepared.text], {type: 'application/json'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = prepared.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else throw Error('File export is unavailable.');
  };
  return (
    <>
      <Panel>
        {!ready && s.devices.length > 1 && (
          <View style={depotLayout.row}>
            {s.devices.map((d) => (
              <Button
                key={d.key}
                label={`Review ${d.name}${d.key === s.deviceKey ? ' (selected)' : ''}`}
                disabled={busy}
                onPress={() => {
                  try {
                    port.selectBatteryProfilingDevice?.(d.key);
                  } catch (error) {
                    setMessage(String(error));
                  }
                }}
              />
            ))}
          </View>
        )}
        <HudText kind="heading">{s.deviceName ?? 'Connect a droid to begin'}</HudText>
        <HudText>
          {s.mode === 'recording'
            ? 'Collection enabled'
            : s.mode === 'waiting-full'
              ? 'Waiting for the next reported full charge'
              : 'Collection stopped'}{' '}
          · {s.sampleCount} captured readings{s.pending ? ' · Saving…' : ''}
        </HudText>
        <HudText muted>
          Start after a full recharge. Collection continues while you use other controller screens,
          taking readings during quiet pauses. Keep the controller open and connected; focus and
          motion safety still apply.
        </HudText>
        <View style={depotLayout.row}>
          <Button
            label="Start after next full charge"
            disabled={disabled || !ready || s.mode === 'recording'}
            onPress={() =>
              void action(
                () => port.armBatteryProfiling!(),
                'Waiting for a reported Full state. If charging happens while disconnected, confirm the full recharge here before normal play.'
              )
            }
          />
          <Button
            label="Start with a fully charged battery"
            disabled={disabled || !ready || s.mode === 'recording'}
            onPress={() => setConfirm('full')}
          />
          <Button
            label="Stop active sources for a quiet reading"
            disabled={disabled || !ready || !s.observationStatus || !port.replaceSources}
            onPress={() =>
              void action(
                () => port.replaceSources!(),
                'Sources stopped and release confirmed. Collection resumes at the next quiet poll.'
              )
            }
          />
          <Button
            label="Stop collecting"
            disabled={disabled || s.mode === 'idle'}
            onPress={() =>
              void action(
                () => port.stopBatteryProfiling!(),
                'Collection stopped. The incomplete cycle is retained.'
              )
            }
          />
          <Button
            label="Finish after low-battery shutdown"
            disabled={disabled || s.mode !== 'recording'}
            onPress={() => setConfirm('shutdown')}
          />
        </View>
        {confirm === 'full' && (
          <View style={{gap: 6}}>
            <HudText>
              Confirm that the battery has just finished a full recharge. Starting partway through a
              discharge produces a misleading profile.
            </HudText>
            <View style={depotLayout.row}>
              <Button
                label="I confirm a full recharge"
                disabled={disabled || !ready}
                onPress={() =>
                  void action(
                    () => port.startBatteryProfileFull!(),
                    'Full-charge start saved; collecting quietly.'
                  )
                }
              />
              <Button label="Cancel" onPress={() => setConfirm(undefined)} />
            </View>
          </View>
        )}
        {confirm === 'shutdown' && (
          <View style={{gap: 6}}>
            <HudText>
              Confirm a normal shutdown caused by low battery just now. A manual disconnect, sleep,
              or lost radio connection is not an empty battery. Do not force a deeper discharge.
            </HudText>
            <View style={depotLayout.row}>
              <Button
                label="Confirm low-battery shutdown"
                disabled={disabled}
                onPress={() =>
                  void action(
                    () => port.finishBatteryProfileShutdown!(),
                    'Low-battery endpoint saved.'
                  )
                }
              />
              <Button label="Cancel" onPress={() => setConfirm(undefined)} />
            </View>
          </View>
        )}
        {!!s.storageError && <HudText>{s.storageError}</HudText>}
        {!!s.observationStatus && <HudText muted>{s.observationStatus}</HudText>}
        {!!s.observationError && <HudText>{s.observationError}</HudText>}
        {!!message && <HudText accessibilityLiveRegion="polite">{message}</HudText>}
      </Panel>
      {run && (
        <Panel>
          <View style={depotLayout.row}>
            {s.runs.map((r, i) => (
              <Button
                key={r.id}
                label={`Cycle ${i + 1}${r.id === run.id ? ' (shown)' : ''}`}
                onPress={() => setSelected(r.id)}
              />
            ))}
          </View>
          <HudText>
            {new Date(run.startedAt).toLocaleString()} · {run.samples.length} readings ·{' '}
            {run.problem ??
              (run.endpoint
                ? `Ended at ${run.endpoint === 'critical' ? 'reported Critical' : 'confirmed low-battery shutdown'}`
                : 'Incomplete cycle')}
          </HudText>
          <BatteryVoltageGraph cycle={run} />
        </Panel>
      )}
      <Panel>
        <HudText kind="heading">Profile review</HudText>
        <HudText muted>
          This estimates the fraction of usable runtime left under similar use, not measured battery
          charge. Plan on at least three full-to-low cycles. A long gap or heavy continuous activity
          can make a cycle unsuitable.
        </HudText>
        <HudText>
          {s.validation.usableCycles} compatible complete cycles ·{' '}
          {candidate ? 'Candidate passed validation' : 'More suitable data needed'}
        </HudText>
        {s.validation.issues.map((issue, i) => (
          <HudText key={i}>{issue}</HudText>
        ))}
        {candidate && (
          <HudText>
            Held-out cycle error: mean {candidate.validation.meanError.toFixed(1)}, maximum{' '}
            {candidate.validation.maxError.toFixed(1)} percentage points.
          </HudText>
        )}
        <DepotDetails title="Calibration requirements and exclusions">
          <HudText muted>
            Two or more cycles train a monotonic voltage curve; the newest complete cycle validates
            it. Each cycle needs 20 quiet readings, 15 minutes, at least 0.10 V decline, a reading
            within two minutes of both endpoints, and no quiet-reading gap over five minutes.
            Endpoints must agree. Validation limits are 10 points mean and 20 points maximum error.
            Passing these checks is not a guarantee for different use.
          </HudText>
          {s.validation.excluded.map((reason, i) => (
            <HudText key={i}>{reason}</HudText>
          ))}
        </DepotDetails>
        <View style={depotLayout.row}>
          <Button
            label="Use this profile"
            disabled={disabled || !candidate}
            onPress={() =>
              candidate &&
              void action(
                () => port.useBatteryProfile!(candidate.id),
                'Profile saved and selected for approximate battery percentages.'
              )
            }
          />
          <Button
            label="Use reported battery state"
            disabled={disabled || !s.activeProfile}
            onPress={() =>
              void action(
                () => port.useReportedBatteryState!(),
                'Battery display now uses the reported state.'
              )
            }
          />
        </View>
        <HudText muted>
          {s.activeProfile
            ? `Accepted profile: ${s.activeProfile.id}. New data only refines the candidate; it does not replace this profile until you choose Use this profile again.`
            : 'The battery display keeps its reported state until you choose Use this profile.'}{' '}
          Estimates use recent quiet voltage and fall back to the reported state when unavailable.
        </HudText>
      </Panel>
      <Panel>
        <View style={depotLayout.row}>
          <Button
            label="Prepare battery data export"
            disabled={busy || s.pending || !s.canExport}
            onPress={() =>
              void action(
                async () => setPrepared(await port.exportBatteryProfiling!()),
                'Export snapshot prepared. Save JSON to write the file.'
              )
            }
          />
          {prepared && (
            <Button
              label="Save battery JSON"
              disabled={busy}
              onPress={() =>
                void action(
                  save,
                  port.exportLocalJson ? 'Battery JSON saved.' : 'Battery JSON download requested.'
                )
              }
            />
          )}
        </View>
        {prepared && (
          <HudText muted>
            {prepared.name} · {prepared.bytes.toLocaleString()} bytes. Canceling a file dialog keeps
            this snapshot ready to save again.
          </HudText>
        )}
      </Panel>
    </>
  );
}
