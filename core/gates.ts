import type { Command } from './protocol.ts';
import { commands } from './commands.ts';
import { capability } from './registry.ts';
import { validateNordicInlineLedPayload } from './ramRecipe.ts';
import { isPlayModeShellQuery } from './playModeShell.ts';
import { validateRecoveredCommand } from './recoveredControls.ts';
export type DriveMode = 'heading' | 'tank' | 'raw';
export interface CommandAccess {
  serviceSession?: boolean;
  replace?: boolean;
}
const vetted = new Set(['10/00', '18/08', '18/09', '17/27', '11/0e', '18/11', '17/2a', '17/39', '13/05', '1f/12', '1f/13', '1f/14', '1f/15', '1f/20', '1f/21', '1f/23', '13/0d', '13/01', '13/03', '13/04', '16/07', '16/08', '16/01', '16/06', '17/0f', '17/14', '17/29', '17/0d', '17/15', '17/16', '17/25', '17/05', '17/2b', '17/0a', '17/2d', '17/2f', '1a/08', '1a/09', '1a/07', '1a/0a', '1a/0e', '18/00', '18/01', '18/0c', '18/0d', '11/00', '11/01', '11/03', '11/06', '11/13', '11/17', '11/1c', '11/1f', '11/24']);
export function validateCommand(command: Command, access: CommandAccess = {}): void {
  const key = [command.did, command.cid].map(n => {
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error('Invalid command identifier');
    return n.toString(16).padStart(2, '0');
  }).join('/');
  // The one vetted read-only shell query does not expose arbitrary shell access.
  if (isPlayModeShellQuery(command)) return;
  if (key === '17/1a') {
    validateNordicInlineLedPayload(command.data);
    return;
  }
  if (key === '17/28') {
    if (command.data.length) throw new Error('Invalid device-light release payload');
    return;
  }
  const entry = capability(key);
  if (entry && (entry.restrictedGate || entry.status !== 'recovered' && key !== '10/00')) throw new Error('Command blocked: restricted or unresolved capability');
  if (entry?.payloadBytes !== null && entry?.payloadBytes !== undefined && entry.payloadBytes !== command.data.length) throw new Error('Command payload length mismatch');
  if (entry?.serviceSession && !access.serviceSession) throw new Error('Confirmed service session required');
  if (!validateRecoveredCommand(command) && !vetted.has(key)) throw new Error('Command has no vetted controller encoder');
  if (key === '1f/12' && (command.data[0] << 8 | command.data[1]) > 1) throw new Error('Indexed tuple index must be 0 or 1');
  if (key === '10/00' && command.data.length > 256) throw new Error('Echo payload exceeds 256 byte controller limit');
  const length: Record<string, number> = {
    '13/05': 1,
    '13/0d': 0,
    '13/01': 0,
    '13/03': 0,
    '13/04': 0,
    '17/0a': 1,
    '17/2f': 1,
    '1a/08': 1,
    '1a/09': 0,
    '1a/07': 3,
    '1a/0a': 0
  };
  if (key in length && command.data.length !== length[key]) throw new Error('Command payload length mismatch');
  // Firmware 0800a14c compares the first collision byte with 3 and rejects larger modes.
  if (key === '18/11' && command.data[0] > 3) throw new Error('Collision mode byte must be 0..3');
  if (key === '16/08' && ![0, 8, 16, 24].includes(command.data[2])) throw new Error('Invalid tank flags');
  if (key === '16/01' && (command.data[0] > 2 || command.data[2] > 2)) throw new Error('Invalid motor mode');
  if (key === '17/0d' && command.data[0] > 3) throw new Error('Invalid leg action');
  if (['17/0a', '17/2d', '17/2f', '17/29', '17/2a', '17/39', '13/05'].includes(key) && command.data[0] > 1) throw new Error('Invalid boolean');
  if (key === '17/05' && (command.data[0] << 8 | command.data[1]) > 55) throw new Error('Invalid animation');
  if (key === '17/0f' || key === '17/15') {
    const v = new DataView(command.data.buffer, command.data.byteOffset, 4).getFloat32(0, false);
    if (!Number.isFinite(v) || (key === '17/0f' ? v < -160 || v > 180 : v < 0 || v > 338.70001220703125)) throw new Error('Invalid articulation target');
  }
  if (key === '1a/0e') {
    if (command.data.length < 2) throw new Error('Invalid LED mask');
    const mask = command.data[0] << 8 | command.data[1];
    if (command.data.length !== 2 + mask.toString(2).replaceAll('0', '').length) throw new Error('Invalid LED payload');
  }
}
/** Ordered broad stop also revokes firmware behavior sources that can resume movement. */
export function stopPlan(mode: DriveMode): Command[] {
  return [commands.stopAnimation(), commands.headTracking(false), commands.idleAnimations(false), commands.droidInteraction(false), commands.trophy(false), commands.legAction(0), mode === 'tank' ? commands.tank(0, 0) : mode === 'raw' ? commands.rawMotors(0, 0, 0, 0) : commands.stop(), commands.stopAudio()];
}

/** True for motion targets, animation starts and enabling reactive motion sources. */
export function requiresMotionArm(c: Command): boolean {
  if (c.did === 0x16) return [1, 7, 8].includes(c.cid) && c.data.some(v => v !== 0);
  if (c.did === 0x17) {
    if ([5, 15, 21].includes(c.cid)) return true;
    if ([10, 13, 41, 45, 47].includes(c.cid)) return c.data[0] !== 0;
  }
  if (isPlayModeShellQuery(c)) return false;
  const key = [c.did, c.cid].map(v => v.toString(16).padStart(2, '0')).join('/');
  return !['1f/12', '1f/13', '1f/14', '1f/15', '1f/20', '1f/21', '1f/23'].includes(key) && (capability(key)?.serviceSession ?? false);
}
