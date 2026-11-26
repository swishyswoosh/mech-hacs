import { commands } from './commands.ts';
import { commandClaim } from './ownership.ts';
import type { Resource } from './ownership.ts';
import { stopPlan } from './gates.ts';
import type { Command } from './protocol.ts';
import type { TelemetryEvent } from './telemetryEvents.ts';
import { streamFields } from './sensors.ts';
import { capability } from './registry.ts';
import { SchedulerSourceLease, validateSourceLeasePort } from './automationLease.ts';
import type { SourceLeasePort } from './automationLease.ts';
export type RecipeEvent = {
  type: 'sample';
  field: string;
  operator: 'above' | 'below';
  value: number;
} | {
  type: 'command-acknowledged';
  did: number;
  cid: number;
};
export type RecipeAction = {
  type: 'drive';
  speed: number;
  heading: number;
} | {
  type: 'head';
  degrees: number;
} | {
  type: 'stance';
  action: number;
} | {
  type: 'lights';
  values: number[];
} | {
  type: 'audio';
  sector: number;
} | {
  type: 'animation';
  id: number;
} | {
  type: 'wait';
} | {
  type: 'wait-event';
  event: RecipeEvent;
  onTimeout: 'stop-run' | 'fail-run';
};
export interface RecipeStep {
  id: string;
  atMs: number;
  durationMs: number;
  repeat?: number;
  action: RecipeAction;
}
export interface Recipe {
  version: 1;
  name: string;
  steps: RecipeStep[];
}
export interface TimelineStep extends RecipeStep {
  iteration: number;
  endMs: number;
}
const integer = (value: unknown, min: number, max: number, name: string) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}–${max}.`);
  return value;
};
export function actionCommand(action: RecipeAction): Command | undefined {
  if (!action || typeof action !== 'object') throw new Error('Unsupported protocol action.');
  switch (action.type) {
    case 'drive':
      return commands.drive(integer(action.speed, 0, 255, 'Speed'), integer(action.heading, 0, 359, 'Heading'));
    case 'head':
      return commands.head(action.degrees);
    case 'stance':
      return commands.legAction(integer(action.action, 0, 3, 'Stance'));
    case 'lights':
      if (!Array.isArray(action.values) || action.values.length !== 8) throw new Error('Lights require eight channel values.');
      return commands.leds(255, action.values);
    case 'audio':
      return commands.audio(integer(action.sector, 0, 65535, 'Sector'));
    case 'animation':
      return commands.animation(integer(action.id, 0, 55, 'Animation'));
    case 'wait':
      return;
    case 'wait-event':
      validateRecipeEvent(action.event);
      if (!['stop-run', 'fail-run'].includes(action.onTimeout)) throw new Error('Event wait requires an explicit stop-run or fail-run timeout outcome.');
      return;
    default:
      throw new Error('Unsupported protocol action.');
  }
}
function validateRecipeEvent(event: RecipeEvent) {
  if (!event || typeof event !== 'object') throw new Error('Event wait requires a supported event.');
  if (event.type === 'sample') {
    if (!streamFields.some(field => field.name === event.field)) throw new Error('Unknown sensor field.');
    if (!['above', 'below'].includes(event.operator) || !Number.isFinite(event.value)) throw new Error('Invalid sensor threshold.');
  } else if (event.type === 'command-acknowledged') {
    integer(event.did, 0, 255, 'Event DID');
    integer(event.cid, 0, 255, 'Event CID');
    const entry = capability([event.did, event.cid].map(v => v.toString(16).padStart(2, '0')).join('/'));
    if (!entry || entry.status !== 'recovered' || entry.restrictedGate || entry.serviceSession) throw new Error('Command event is not an available recovered capability.');
  } else throw new Error('Unsupported event source.');
}
function eventMatches(expected: RecipeEvent, event: TelemetryEvent): boolean {
  if (expected.type === 'sample' && event.type === 'sample') {
    const value = event.values[expected.field];
    return Number.isFinite(value) && (expected.operator === 'above' ? value > expected.value : value < expected.value);
  }
  return expected.type === 'command-acknowledged' && event.type === 'command' && event.phase === 'acknowledged' && event.did === expected.did && event.cid === expected.cid;
}
class EventWaitTimeout extends Error {
  outcome: 'stop-run' | 'fail-run';
  constructor(id: string, outcome: 'stop-run' | 'fail-run') {
    super(`Event wait ${id} timed out; ${outcome}.`);
    this.outcome = outcome;
  }
}
function actionResources(action: RecipeAction): Resource[] {
  // A zero or stop still writes its actuator; it cannot overlap another writer.
  if (action.type === 'drive' || action.type === 'stance') return ['drive', 'stance'];
  const command = actionCommand(action);
  return command ? commandClaim(command)?.resources || [] : [];
}
export function recipeTimeline(recipe: Recipe): TimelineStep[] {
  if (!recipe || recipe.version !== 1 || typeof recipe.name !== 'string' || !recipe.name.trim() || recipe.name.length > 120 || !Array.isArray(recipe.steps) || recipe.steps.length > 128) throw new Error('Expected a version 1 protocol, a name and at most 128 steps.');
  const timeline: TimelineStep[] = [];
  const ids = new Set<string>();
  for (const step of recipe.steps) {
    if (!step || typeof step.id !== 'string' || !step.id || ids.has(step.id)) throw new Error('Every step needs a unique ID.');
    ids.add(step.id);
    integer(step.atMs, 0, 600000, 'Start time');
    integer(step.durationMs, 1, 600000, 'Duration');
    const repeat = integer(step.repeat ?? 1, 1, 100, 'repeat');
    actionCommand(step.action);
    for (let i = 0; i < repeat; i++) {
      const atMs = step.atMs + i * step.durationMs,
        endMs = atMs + step.durationMs;
      if (endMs > 600000) throw new Error('Protocol exceeds ten minutes.');
      timeline.push({
        ...step,
        atMs,
        endMs,
        iteration: i
      });
    }
  }
  if (timeline.length > 512) throw new Error('Protocol exceeds 512 scheduled actions.');
  timeline.sort((a, b) => a.atMs - b.atMs);
  for (const gate of timeline.filter(step => step.action.type === 'wait-event'))
    if (timeline.some(step => step !== gate && step.atMs > gate.atMs && step.atMs < gate.endMs))
      throw new Error('Start dependent actions at or after the event-wait window ends.');
  for (let i = 0; i < timeline.length; i++)
    for (let j = i + 1; j < timeline.length && timeline[j].atMs < timeline[i].endMs; j++) {
      const aa = actionResources(timeline[i].action),
        bb = actionResources(timeline[j].action);
      if (aa?.some(r => bb?.includes(r))) throw new Error(`Resource overlap: ${timeline[i].id} and ${timeline[j].id}.`);
    }
  return timeline;
}
export function moveRecipeStep(input: Recipe, index: number, direction: -1 | 1): Recipe {
  const recipe = parseRecipe(serializeRecipe(input));
  integer(index, 0, recipe.steps.length - 1, 'Selected step');
  const target = index + direction;
  if (target < 0 || target >= recipe.steps.length) throw new Error('Step is already at the timeline boundary.');
  [recipe.steps[index], recipe.steps[target]] = [recipe.steps[target], recipe.steps[index]];
  let atMs = 0;
  recipe.steps = recipe.steps.map(step => {
    const moved = {
      ...step,
      atMs
    };
    atMs += step.durationMs * (step.repeat ?? 1);
    return moved;
  });
  return validateRecipe(recipe);
}
export function validateRecipe(recipe: Recipe): Recipe {
  recipeTimeline(recipe);
  return recipe;
}
export function parseRecipe(text: string): Recipe {
  if (text.length > 200000) throw new Error('Protocol file too large.');
  return validateRecipe(JSON.parse(text));
}
export function serializeRecipe(recipe: Recipe): string {
  return JSON.stringify(validateRecipe(recipe), null, 2);
}
function endCommands(action: RecipeAction): Command[] {
  switch (action.type) {
    case 'drive':
      return [commands.stop()];
    case 'stance':
      return [commands.legAction(0)];
    case 'audio':
      return [commands.stopAudio()];
    case 'animation':
      return stopPlan('heading');
    default:
      return [];
  }
}
export interface AutomationSensorState {
  status: string;
  sampleAt?: number;
  intervalMs: number;
  values: Record<string, number>;
}
export interface AutomationPort extends SourceLeasePort {
  sensorState?(): AutomationSensorState | undefined;
  execute(command: Command): Promise<unknown>;
  armMotion(): void;
  replaceSources?(): Promise<void>;
  stop(): Promise<void>;
  subscribeEvents?(listener: (event: TelemetryEvent) => void): () => void;
}
function preflightSensorWaits(timeline: TimelineStep[], port: AutomationPort) {
  const required = [...new Set(timeline.flatMap(step => step.action.type === 'wait-event' && step.action.event.type === 'sample' ? [step.action.event.field] : []))];
  if (!required.length) return;
  const sensors = port.sensorState?.();
  for (const field of required)
    if (!sensors || sensors.status !== 'streaming' || !Number.isFinite(sensors.values[field]) ||
        !Number.isFinite(sensors.sampleAt) ||
        Date.now() - (sensors.sampleAt ?? 0) > Math.max(500, 3 * sensors.intervalMs))
      throw new Error(`Sensor wait needs fresh ${field}. Open Sensors, start streaming and wait for that field before Play; no reconnect was requested.`);
}
export interface RunSnapshot {
  status: 'preparing' | 'running' | 'completed' | 'cancelled' | 'failed';
  name: string;
  step?: string;
  error?: string;
}
/** One foreground run; all timing and commands belong to an immutable validated snapshot. */
export class AutomationRunner {
  private generation = 0;
  private active = false;
  private sourceLease?: SchedulerSourceLease;
  private eventCleanup?: () => void;
  private waits = new Set<() => void>();
  private port: AutomationPort;
  private changed: (snapshot: RunSnapshot) => void;
  constructor(port: AutomationPort, changed: (snapshot: RunSnapshot) => void = () => {}) {
    this.port = port;
    this.changed = changed;
  }
  private async delay(ms: number, generation: number) {
    const until = performance.now() + ms;
    while (generation === this.generation && performance.now() < until) {
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer);
          this.waits.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(1, Math.ceil(Math.min(50, until - performance.now()))));
        this.waits.add(done);
      });
      // Dispatcher progress through a timed wait renews the lease. Pending droid
      // responses never enter this loop and receive no renewal.
      if (generation !== this.generation || !this.sourceLease?.pulse()) return;
    }
  }
  async cancel(sendStop = true) {
    if (!this.active) return;
    this.generation++;
    this.active = false;
    this.sourceLease?.close();
    this.eventCleanup?.();
    for (const done of [...this.waits]) done();
    this.changed({
      status: 'cancelled',
      name: ''
    });
    if (sendStop) await this.port.stop();
  }
  async play(input: Recipe, beforeStart?: () => Promise<void>): Promise<void> {
    if (this.active) throw new Error('Stop the current run first.');
    const recipe = parseRecipe(serializeRecipe(input)),
      timeline = recipeTimeline(recipe);
    if (!timeline.length) throw new Error('Add a step first.');
    if (!this.port.replaceSources) throw new Error('Safe source replacement is unavailable.');
    if (timeline.some(step => step.action.type === 'wait-event') && !this.port.subscribeEvents) throw new Error('Live event source is unavailable.');
    validateSourceLeasePort(this.port);
    preflightSensorWaits(timeline, this.port);
    if (beforeStart) await beforeStart();
    if (this.active) throw new Error('Stop the current run first.');
    const generation = ++this.generation;
    this.active = true;
    const valid = () => this.active && generation === this.generation;
    this.changed({
      status: 'preparing',
      name: recipe.name
    });
    const eventWaits = new Map<TimelineStep, {
      matched: boolean;
      openedAt: number;
      close: () => void;
    }>();
    let cleanup: (() => void) | undefined;
    let started = 0;
    let pendingStop: Promise<void> | undefined;
    const fail = async (error: unknown) => {
      if (!valid()) return;
      this.generation++;
      this.active = false;
      this.sourceLease?.close();
      this.eventCleanup?.();
      for (const done of [...this.waits]) done();
      this.changed({
        status: error instanceof EventWaitTimeout && error.outcome === 'stop-run' ? 'cancelled' : 'failed',
        name: recipe.name,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.port.stop().catch(() => {});
    };
    const sourceLease = new SchedulerSourceLease(this.port, 'automation', valid, error => {
      pendingStop = fail(error);
    }, {
      externalPulse: true
    });
    this.sourceLease = sourceLease;
    try {
      if (this.port.subscribeEvents) {
        const unsubscribe = this.port.subscribeEvents(event => {
          if (!valid()) return;
          if (event.type === 'connection' && event.state !== 'ready') {
            void this.cancel(false);
            return;
          }
          for (const [step, wait] of eventWaits)
            if (!wait.matched && performance.now() - started < step.endMs &&
                event.at >= wait.openedAt && step.action.type === 'wait-event' &&
                eventMatches(step.action.event, event)) {
              wait.matched = true;
              wait.close();
              this.changed({
                status: 'running',
                name: recipe.name,
                step: `${step.id} · event matched; waiting for timeline boundary`
              });
            }
        });
        let subscribed = true;
        cleanup = () => {
          if (subscribed) {
            subscribed = false;
            unsubscribe();
          }
        };
        this.eventCleanup = cleanup;
      }
      await this.port.replaceSources();
      if (!valid()) return;
      if (!(await sourceLease.acquire()) || !valid()) return;
      preflightSensorWaits(timeline, this.port);
      this.port.armMotion();
      started = performance.now();
      // Ends sort before starts at a shared boundary, preventing overlapping writes.
      const events = timeline.flatMap(step => {
        const events = [{
          at: step.atMs,
          start: true,
          step
        }, {
          at: step.endMs,
          start: false,
          step
        }];
        if (step.action.type === 'drive' && step.action.speed > 0)
          for (let at = step.atMs + 100; at < step.endMs; at += 100)
            events.push({
              at,
              start: true,
              step
            });
        return events;
      }).sort((a, b) => a.at - b.at || Number(a.start) - Number(b.start) || (a.step.action.type === 'wait-event' ? -1 : 0) - (b.step.action.type === 'wait-event' ? -1 : 0));
      for (const event of events) {
        await this.delay(event.at - (performance.now() - started), generation);
        if (!valid() || !sourceLease.pulse()) return;
        const checkDeadline = () => {
          if (event.start && (performance.now() - started - event.at > 250 || performance.now() - started >= event.step.endMs)) throw new Error('Scheduling deadline missed; stale actions cancelled');
        };
        checkDeadline();
        if (event.step.action.type === 'wait-event') {
          if (event.start) {
            const step = event.step;
            const action = event.step.action;
            const wait = {
              matched: false,
              openedAt: Date.now(),
              close: () => {}
            };
            const close = () => {
              clearTimeout(timer);
              this.waits.delete(close);
            };
            const timer = setTimeout(() => {
              close();
              if (valid() && !wait.matched) pendingStop = fail(new EventWaitTimeout(step.id, action.onTimeout));
            }, Math.max(0, Math.ceil(step.endMs - (performance.now() - started))));
            wait.close = close;
            this.waits.add(close);
            eventWaits.set(step, wait);
          } else {
            const wait = eventWaits.get(event.step);
            wait?.close();
            eventWaits.delete(event.step);
            if (!wait?.matched) throw new EventWaitTimeout(event.step.id, event.step.action.onTimeout);
          }
        }
        const list = event.start ? [actionCommand(event.step.action)].filter((c): c is Command => !!c) : endCommands(event.step.action);
        this.changed({
          status: 'running',
          name: recipe.name,
          step: `${event.step.id} · ${event.step.action.type}${event.start ? '' : ' finished'}`
        });
        if (event.start && event.step.action.type === 'animation') {
          await this.port.replaceSources();
          if (!valid() || !sourceLease.pulse()) return;
          checkDeadline();
          this.port.armMotion();
        }
        for (const command of list) {
          if (!valid()) return;
          checkDeadline();
          await this.port.execute(command);
          if (!valid() || !sourceLease.pulse()) return;
        }
      }
      if (valid()) {
        this.active = false;
        this.changed({
          status: 'completed',
          name: recipe.name
        });
      }
    } catch (error) {
      await fail(error);
    } finally {
      sourceLease.close();
      if (this.sourceLease === sourceLease) this.sourceLease = undefined;
      for (const wait of eventWaits.values()) wait.close();
      cleanup?.();
      if (this.eventCleanup === cleanup) this.eventCleanup = undefined;
      await pendingStop;
    }
  }
}
export interface PathPoint {
  x: number;
  y: number;
}
export function previewPath(points: PathPoint[], speedPercent: number, startOrientation: number) {
  integer(speedPercent, 0, 100, 'Speed cap');
  integer(startOrientation, 0, 359, 'Start orientation');
  if (!Array.isArray(points) || points.length > 256 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('Invalid path points.');
  return points.slice(1).map((point, i) => {
    const dx = point.x - points[i].x,
      dy = point.y - points[i].y;
    return {
      heading: ((Math.round(Math.atan2(dx, -dy) * 180 / Math.PI) + startOrientation) % 360 + 360) % 360,
      length: Math.hypot(dx, dy),
      speed: Math.round(speedPercent * 255 / 100)
    };
  }).filter(segment => segment.length > 0);
}
export interface PathDraft {
  version: 1;
  units: 'preview';
  points: PathPoint[];
  speedPercent: number;
  startOrientation: number;
}
export function parsePathDraft(text: string): PathDraft {
  if (text.length > 50000) throw new Error('Path draft is too large.');
  const value = JSON.parse(text);
  if (!value || value.version !== 1 || value.units !== 'preview') throw new Error('Expected a version 1 path in preview units.');
  previewPath(value.points, value.speedPercent, value.startOrientation);
  return value;
}
export function serializePathDraft(draft: PathDraft): string {
  const text = JSON.stringify(draft);
  parsePathDraft(text);
  return text;
}
