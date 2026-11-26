import { commands } from './commands.ts';
import type { Command } from './protocol.ts';
import { parseRecipe } from './automation.ts';
import type { Recipe } from './automation.ts';
import { validateLocalJsonFiles } from './localJson.ts';
import { SchedulerSourceLease, validateSourceLeasePort } from './automationLease.ts';
import type { SourceLeasePort } from './automationLease.ts';
export type ExperienceAction = {
    type: 'animation';
    id: number;
} | {
    type: 'audio';
    sector: number;
} | {
    type: 'head';
    degrees: number;
} | {
    type: 'lights';
    values: number[];
};
export type TimelineCue = {
    atMs: number;
    action: ExperienceAction;
};
export type LocalTimeline = {
    version: 1;
    title: string;
    language: string;
    edition: string;
    cues: TimelineCue[];
};
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected a JSON object.');
    return value as RecordValue;
}
function text(value: unknown, label: string) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000)
        throw new Error(`${label} must be nonempty text (up to 1000 characters).`);
    return value;
}
function array(value: unknown, label: string, max = 10000): unknown[] {
    if (!Array.isArray(value) || value.length > max)
        throw new Error(`${label} must be an array of at most ${max} entries.`);
    return value;
}
function finite(value: unknown, label: string, min: number, max: number) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        throw new Error(`${label} must be ${min} to ${max}.`);
    return value;
}
function integer(value: unknown, label: string, max: number) {
    const n = finite(value, label, 0, max);
    if (!Number.isInteger(n))
        throw new Error(`${label} must be an integer.`);
    return n;
}
export function parseExperienceAction(value: unknown): ExperienceAction {
    const a = record(value);
    switch (a.type) {
        case 'animation': return { type: 'animation', id: integer(a.id, 'Animation ID', 55) };
        case 'audio': return { type: 'audio', sector: integer(a.sector, 'Sound sector', 65535) };
        case 'head': return { type: 'head', degrees: finite(a.degrees, 'Dome degrees', -160, 180) };
        case 'lights': {
            const values = array(a.values, 'LED channels', 8);
            if (values.length !== 8)
                throw new Error('Exactly eight LED channels required.');
            return { type: 'lights', values: values.map(v => integer(v, 'Brightness', 255)) };
        }
        default: throw new Error('Unknown action. Allowed: animation, audio, head, lights.');
    }
}
export function experienceCommand(action: ExperienceAction): Command {
    const a = parseExperienceAction(action);
    switch (a.type) {
        case 'animation': return commands.animation(a.id);
        case 'audio': return commands.audio(a.sector);
        case 'head': return commands.head(a.degrees);
        case 'lights': return commands.leds(255, a.values);
    }
}
export function actionDescription(a: ExperienceAction) {
    switch (a.type) {
        case 'animation': return `Animation ${a.id} · may move the droid; movement content unknown`;
        case 'audio': return `Sound sector ${a.sector} · audio only`;
        case 'head': return `Dome ${a.degrees}° · moves dome`;
        case 'lights': return 'Eight light channels · lights only';
    }
}
export function parseTimeline(value: unknown): LocalTimeline {
    const d = record(value);
    if (d.version !== 1)
        throw new Error('Timeline version must be 1.');
    const byTime = new Map<number, TimelineCue>();
    for (const item of array(d.cues, 'Timeline cues')) {
        const c = record(item);
        const atMs = integer(c.atMs, 'Cue milliseconds', 24 * 60 * 60 * 1000);
        byTime.set(atMs, { atMs, action: parseExperienceAction(c.action) });
    }
    return {
        version: 1,
        title: text(d.title, 'Title'),
        language: text(d.language, 'Language'),
        edition: text(d.edition, 'Edition'),
        cues: [...byTime.values()].sort((a, b) => a.atMs - b.atMs)
    };
}
export type LocalJsonFile = {
    name: string;
    text: string;
};
/** Users may select untouched retained timeline/event JSON alongside their own
 * compatibility metadata, or import one already-normalized local timeline. */
export function importTimelineFiles(files: LocalJsonFile[], animationIds: Record<string, number>): LocalTimeline {
    if (!Array.isArray(files) || files.length < 1 || files.length > 3)
        throw new Error('Choose one local timeline or three files: timeline, event data and compatibility metadata.');
    validateLocalJsonFiles(files);
    const values = files.map(f => record(JSON.parse(f.text)));
    if (values.length === 1) {
        const value = values[0];
        if (value.timeline !== undefined || value.eventData !== undefined) {
            return importRecoveredTimeline(value.timeline, value.eventData, {
                title: text(value.title, 'Title'),
                language: text(value.language, 'Language'),
                edition: text(value.edition, 'Edition')
            }, animationIds);
        }
        return parseTimeline(value);
    }
    const timeline = values.filter(v => Array.isArray(v.timelines));
    const events = values.filter(v => Array.isArray(v.events));
    const metadata = values.filter(v => !Array.isArray(v.timelines) && !Array.isArray(v.events));
    if (timeline.length !== 1 || events.length !== 1 || metadata.length !== 1)
        throw new Error('Choose exactly one timeline JSON, one event-data JSON and one metadata JSON with title, language and edition.');
    const m = metadata[0];
    return importRecoveredTimeline(timeline[0], events[0], {
        title: text(m.title, 'Title'),
        language: text(m.language, 'Language'),
        edition: text(m.edition, 'Edition')
    }, animationIds);
}
/** Retained data uses seconds; duplicate timestamp assignment overwrites earlier entries,
 * including a later text-only event replacing an animation. No image/text media is copied. */
export function importRecoveredTimeline(timeline: unknown, events: unknown, metadata: Pick<LocalTimeline, 'title' | 'language' | 'edition'>, animationIds: Record<string, number>): LocalTimeline {
    const definitions = new Map<string, RecordValue>();
    for (const item of array(record(events).events, 'Event definitions')) {
        const event = record(item);
        definitions.set(text(event.id, 'Event ID'), event);
    }
    const byTime = new Map<number, RecordValue>();
    for (const item of array(record(timeline).timelines, 'Recovered timeline')) {
        const entry = record(item);
        const raw = entry.timestamp;
        const timestamp = finite(typeof raw === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw, 'Timestamp', -3600, 86400);
        const event = definitions.get(text(entry.id, 'Timeline ID'));
        if (!event)
            throw new Error(`Missing event definition ${entry.id}`);
        byTime.set(timestamp, event);
    }
    const cues: TimelineCue[] = [];
    for (const [seconds, event] of byTime) {
        const variants = array(event.events, 'Event variants', 1);
        if (variants.length !== 1)
            throw new Error('Only audited single-variant recovered events are supported.');
        const variant = record(variants[0]);
        if (variant.weight !== 100)
            throw new Error('Only audited weight-100 events are supported.');
        const info = record(variant.eventinfo);
        const names = array(info.animations, 'Animation names').filter(v => v !== '');
        if (names.length > 1)
            throw new Error('Multiple simultaneous animations require a typed recipe.');
        if (!names.length || seconds < 0)
            continue;
        const name = text(names[0], 'Animation name');
        const id = animationIds[name];
        if (id === undefined)
            throw new Error(`Unknown recovered animation ${name}`);
        cues.push({ atMs: Math.round(seconds * 1000), action: { type: 'animation', id } });
    }
    return parseTimeline({ ...metadata, version: 1, cues });
}
/** Platform-independent monotonic schedule. Consumers serialize writes and cancel
 * in-flight intent before STOP. A late tick pauses instead of bursting movement. */
export class TimelineClock {
    readonly timeline: LocalTimeline;
    private now: () => number;
    private position = 0;
    private anchor = 0;
    private cursor = 0;
    running = false;
    constructor(timeline: LocalTimeline, now: () => number = () => performance.now()) {
        this.timeline = parseTimeline(timeline);
        this.now = now;
    }
    get positionMs() {
        return this.position + (this.running ? Math.max(0, this.now() - this.anchor) : 0);
    }
    start() {
        if (!this.timeline.cues.length)
            throw new Error('Timeline has no playable cues.');
        this.anchor = this.now();
        this.running = true;
    }
    pause() {
        this.position = this.positionMs;
        this.running = false;
    }
    seek(ms: number) {
        this.pause();
        this.position = finite(ms, 'Seek milliseconds', 0, 86400000);
        this.cursor = this.timeline.cues.findIndex(c => c.atMs >= ms);
        if (this.cursor < 0)
            this.cursor = this.timeline.cues.length;
    }
    takeDue(): TimelineCue[] {
        if (!this.running)
            return [];
        const position = this.positionMs;
        const cue = this.timeline.cues[this.cursor];
        if (!cue) {
            this.pause();
            return [];
        }
        if (position - cue.atMs > 1000) {
            this.pause();
            throw new Error('Timeline cue too late after suspension. Seek/resynchronize before restarting.');
        }
        // A single due cue lets the session await its command before advancing again.
        if (cue.atMs > position)
            return [];
        this.cursor++;
        if (this.cursor === this.timeline.cues.length)
            this.pause();
        return [cue];
    }
}
type TimelinePort = SourceLeasePort & {
    replaceSources: () => Promise<void>;
    armMotion: () => void;
    execute: (command: Command, access: {
        replace: true;
    }) => Promise<unknown>;
    stop: () => Promise<void>;
};
export class TimelineSession {
    readonly clock: TimelineClock;
    private port: TimelinePort;
    private epoch = 0;
    private busy = false;
    private sourceLease?: SchedulerSourceLease;
    preparing = false;
    active = false;
    error = '';
    constructor(timeline: LocalTimeline, port: TimelinePort, now?: () => number) {
        this.clock = new TimelineClock(timeline, now);
        this.port = port;
    }
    async start() {
        if (this.active || this.preparing)
            throw new Error('Pause the current movie before starting another run.');
        validateSourceLeasePort(this.port);
        const epoch = ++this.epoch;
        this.preparing = true;
        this.error = '';
        const valid = () => epoch === this.epoch && (this.preparing || this.active);
        const sourceLease = new SchedulerSourceLease(this.port, 'movie', valid, error => {
            if (!valid())
                return;
            this.error = String(error);
            void this.pause().catch(() => { });
        }, { externalPulse: true });
        this.sourceLease = sourceLease;
        try {
            await this.port.replaceSources();
            if (!valid())
                return;
            if (!await sourceLease.acquire() || !valid() || !sourceLease.pulse())
                return;
            this.port.armMotion();
            this.clock.start();
            this.active = true;
        }
        catch (error) {
            if (epoch === this.epoch) {
                this.error = String(error);
                await this.pause().catch(() => { });
                throw error;
            }
        }
        finally {
            if (epoch === this.epoch)
                this.preparing = false;
        }
    }
    async pause(stopDroid = true) {
        ++this.epoch;
        this.preparing = false;
        this.active = false;
        this.sourceLease?.close();
        this.sourceLease = undefined;
        this.clock.pause();
        if (stopDroid)
            await this.port.stop();
    }
    async seek(ms: number) {
        this.clock.seek(ms);
        await this.pause();
    }
    async tick() {
        if (this.busy || !this.active)
            return;
        // Lease renewal comes from real scheduler ticks, including waits for future
        // cues. An awaited command/replace response cannot renew behind the wait.
        if (!this.sourceLease?.pulse() || !this.clock.running)
            return;
        const epoch = this.epoch;
        this.busy = true;
        try {
            for (const cue of this.clock.takeDue()) {
                if (epoch !== this.epoch)
                    return;
                await this.port.execute(experienceCommand(cue.action), { replace: true });
                if (epoch === this.epoch)
                    this.sourceLease?.pulse();
            }
        }
        catch (error) {
            if (epoch === this.epoch) {
                this.error = String(error);
                await this.pause().catch(() => { });
            }
        }
        finally {
            this.busy = false;
        }
    }
}
/** A resident single action has unknown completion. Its independent source lease
 * lasts until explicit STOP/replacement because an ACK does not establish completion. */
export class EnvironmentReactionSession {
    private port: TimelinePort;
    private epoch = 0;
    private sourceLease?: SchedulerSourceLease;
    active = false;
    error = '';
    constructor(port: TimelinePort) {
        this.port = port;
    }
    async cancel(stopDroid = false) {
        ++this.epoch;
        this.active = false;
        this.sourceLease?.close();
        this.sourceLease = undefined;
        if (stopDroid)
            await this.port.stop();
    }
    async play(input: ExperienceAction) {
        const command = experienceCommand(input);
        if (this.active)
            throw new Error('Stop the current environment reaction first.');
        validateSourceLeasePort(this.port);
        const epoch = ++this.epoch;
        this.active = true;
        this.error = '';
        const valid = () => epoch === this.epoch && this.active;
        const lease = new SchedulerSourceLease(this.port, 'environment', valid, error => {
            if (!valid())
                return;
            this.error = String(error);
            void this.cancel(true).catch(() => { });
        });
        this.sourceLease = lease;
        try {
            if (!await lease.acquire() || !valid())
                return;
            await this.port.replaceSources();
            if (!valid())
                return;
            this.port.armMotion();
            await this.port.execute(command, { replace: true });
        }
        catch (error) {
            if (valid()) {
                this.error = String(error);
                await this.cancel(true).catch(() => { });
                throw error;
            }
        }
    }
}
export type EnvironmentHotspot = {
    id: string;
    title: string;
    x: number;
    y: number;
    action?: ExperienceAction;
    recipeId?: string;
};
export type VectorElement = {
    shape: 'rect' | 'ellipse';
    x: number;
    y: number;
    width: number;
    height: number;
    fill: string;
};
export type EnvironmentAsset = {
    id: string;
    sha256: string;
} & ({
    kind: 'raster';
    uri: string;
} | {
    kind: 'vector';
    elements: VectorElement[];
});
export type EnvironmentRecipe = {
    id: string;
    recipe: Recipe;
};
export type EnvironmentRoom = {
    id: string;
    title: string;
    description: string;
    color: string;
    background?: string;
    exits: string[];
    hotspots: EnvironmentHotspot[];
};
export type EnvironmentPack = {
    version: 1;
    appVersion: 1;
    id: string;
    title: string;
    startRoom: string;
    assets?: EnvironmentAsset[];
    recipes?: EnvironmentRecipe[];
    rooms: EnvironmentRoom[];
};
/** Validates embedded asset shapes, room references and typed recipes.
 * Asset hashes and raster decoding are checked separately by verifyEnvironment. */
export function parseEnvironment(value: unknown): EnvironmentPack {
    const pack = record(value);
    if (pack.version !== 1 || pack.appVersion !== 1)
        throw new Error('Environment and compatible app version must both be 1.');
    const colorValue = (value: unknown) => {
        const color = text(value, 'Color');
        if (!/^#[a-f\d]{6}$/i.test(color))
            throw new Error('Color must be #RRGGBB.');
        return color;
    };
    const assets: EnvironmentAsset[] = array(pack.assets ?? [], 'Assets', 64).map(value => {
        const a = record(value), id = text(a.id, 'Asset ID'), sha256 = text(a.sha256, 'Asset hash');
        if (!/^[a-f0-9]{64}$/.test(sha256))
            throw new Error('Asset hash must be lowercase SHA-256.');
        if (a.kind === 'raster') {
            if (typeof a.uri !== 'string' || a.uri.length > 2000000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(a.uri))
                throw new Error('Raster background must be an embedded local PNG, JPEG or WebP data URI.');
            return {
                id, sha256, kind: 'raster', uri: a.uri
            };
        }
        if (a.kind === 'vector') {
            const elements: VectorElement[] = array(a.elements, 'Vector elements', 256).map(value => {
                const e = record(value);
                if (e.shape !== 'rect' && e.shape !== 'ellipse')
                    throw new Error('Vector shape must be rect or ellipse.');
                return {
                    shape: e.shape,
                    x: finite(e.x, 'Vector x', 0, 1),
                    y: finite(e.y, 'Vector y', 0, 1),
                    width: finite(e.width, 'Vector width', 0, 1),
                    height: finite(e.height, 'Vector height', 0, 1),
                    fill: colorValue(e.fill)
                };
            });
            return {
                id, sha256, kind: 'vector', elements
            };
        }
        throw new Error('Asset kind must be raster or vector.');
    });
    if (new Set(assets.map(a => a.id)).size !== assets.length)
        throw new Error('Duplicate asset ID.');
    const recipes: EnvironmentRecipe[] = array(pack.recipes ?? [], 'Recipes', 128).map(value => {
        const r = record(value);
        return { id: text(r.id, 'Recipe ID'), recipe: parseRecipe(JSON.stringify(r.recipe)) };
    });
    if (new Set(recipes.map(r => r.id)).size !== recipes.length)
        throw new Error('Duplicate recipe ID.');
    const rooms = array(pack.rooms, 'Rooms', 100).map(value => {
        const room = record(value);
        if (room.assets !== undefined)
            throw new Error('Declare local assets on the pack manifest.');
        const background = room.background === undefined ? undefined : text(room.background, 'Background asset');
        if (background && !assets.some(a => a.id === background))
            throw new Error('Background asset is missing.');
        const color = text(room.color, 'Scene color');
        if (!/^#[a-f\d]{6}$/i.test(color))
            throw new Error('Scene color must be #RRGGBB.');
        const hotspots: EnvironmentHotspot[] = array(room.hotspots, 'Hotspots', 100).map(value => {
            const h = record(value);
            if ((h.action === undefined) === (h.recipeId === undefined))
                throw new Error('Hotspot needs exactly one action or recipeId.');
            const recipeId = h.recipeId === undefined ? undefined : text(h.recipeId, 'Recipe reference');
            if (recipeId && !recipes.some(r => r.id === recipeId))
                throw new Error('Missing hotspot recipe reference.');
            return {
                id: text(h.id, 'Hotspot ID'),
                title: text(h.title, 'Hotspot title'),
                x: finite(h.x, 'Hotspot x coordinate', 0, 1),
                y: finite(h.y, 'Hotspot y coordinate', 0, 1),
                ...(recipeId ? { recipeId } : { action: parseExperienceAction(h.action) })
            };
        });
        if (new Set(hotspots.map(h => h.id)).size !== hotspots.length)
            throw new Error('Duplicate hotspot ID.');
        return {
            id: text(room.id, 'Room ID'),
            title: text(room.title, 'Room title'),
            description: text(room.description, 'Room description'),
            color,
            ...(background ? { background } : {}),
            exits: array(room.exits, 'Exits', 100).map(v => text(v, 'Exit room')),
            hotspots
        };
    });
    const ids = new Set(rooms.map(r => r.id));
    if (ids.size !== rooms.length)
        throw new Error('Duplicate room ID.');
    const startRoom = text(pack.startRoom, 'Start room');
    if (!ids.has(startRoom))
        throw new Error('Start room is missing.');
    for (const room of rooms)
        for (const exit of room.exits)
            if (!ids.has(exit))
                throw new Error(`Missing exit room ${exit}`);
    return {
        version: 1,
        appVersion: 1,
        id: text(pack.id, 'Pack ID'),
        title: text(pack.title, 'Pack title'),
        startRoom,
        ...(assets.length ? { assets } : {}),
        ...(recipes.length ? { recipes } : {}),
        rooms
    };
}
export async function verifyEnvironment(value: unknown, hashText: (text: string) => Promise<{
    sha256: string;
    bytes: number;
}>, validateRaster?: (uri: string) => Promise<void>): Promise<EnvironmentPack> {
    const pack = parseEnvironment(value);
    for (const asset of pack.assets ?? []) {
        const payload = asset.kind === 'raster' ? { kind: asset.kind, uri: asset.uri } : { kind: asset.kind, elements: asset.elements };
        const result = await hashText(JSON.stringify(payload));
        if (result.sha256 !== asset.sha256)
            throw new Error(`Background asset hash mismatch: ${asset.id}`);
        if (asset.kind === 'raster' && validateRaster)
            await validateRaster(asset.uri);
    }
    return pack;
}
export const demoEnvironment: EnvironmentPack = {
    version: 1,
    appVersion: 1,
    id: 'open-orbital-workshop',
    title: 'Orbital Workshop · original demo',
    startRoom: 'workshop',
    assets: [{
            id: 'workshop-vector',
            sha256: 'c008f523f3d853ef2c2953101341b01f56396d1c9d5cdced842cbccd6c78fa5c',
            kind: 'vector',
            elements: [{
                    shape: 'rect',
                    x: 0.1,
                    y: 0.15,
                    width: 0.8,
                    height: 0.6,
                    fill: '#245267'
                }, {
                    shape: 'ellipse',
                    x: 0.65,
                    y: 0.22,
                    width: 0.15,
                    height: 0.22,
                    fill: '#d2ebf0'
                }]
        }],
    recipes: [{
            id: 'console-lights',
            recipe: {
                version: 1,
                name: 'Console lights',
                steps: [{
                        id: 'console-on',
                        atMs: 0,
                        durationMs: 1000,
                        action: { type: 'lights', values: [0, 80, 120, 0, 80, 120, 30, 0] }
                    }, {
                        id: 'console-off',
                        atMs: 1000,
                        durationMs: 1,
                        action: { type: 'lights', values: [0, 0, 0, 0, 0, 0, 0, 0] }
                    }]
            }
        }],
    rooms: [
        {
            id: 'workshop',
            title: 'Workshop',
            description: 'A fictional orbital workshop. Touch the console to review its light reaction, or explore the observation deck.',
            color: '#153c50',
            background: 'workshop-vector',
            exits: ['deck'],
            hotspots: [{
                    id: 'console',
                    title: 'Power console',
                    x: 0.3,
                    y: 0.55,
                    recipeId: 'console-lights'
                }]
        },
        {
            id: 'deck',
            title: 'Observation deck',
            description: 'Stars shine beyond the virtual windows. This scenery does not describe the droid’s physical surroundings.',
            color: '#252645',
            exits: ['workshop'],
            hotspots: [{
                    id: 'beacon',
                    title: 'Signal beacon',
                    x: 0.7,
                    y: 0.4,
                    action: { type: 'audio', sector: 2813 }
                }]
        }
    ]
};
export const demoTimeline: LocalTimeline = {
    version: 1,
    title: 'Original light rehearsal',
    language: 'No dialogue',
    edition: 'Three-cue controller demo; not a film edition',
    cues: [
        { atMs: 1000, action: { type: 'lights', values: [30, 0, 0, 30, 0, 0, 20, 0] } },
        { atMs: 3000, action: { type: 'lights', values: [0, 0, 50, 0, 0, 50, 40, 0] } },
        { atMs: 5000, action: { type: 'lights', values: [0, 0, 0, 0, 0, 0, 0, 0] } }
    ]
};
