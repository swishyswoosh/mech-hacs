import { encodePacket, PacketDecoder } from './protocol.ts';
import type { Command, Packet } from './protocol.ts';
import { commands } from './commands.ts';
import { compileNordicInlineLedRecipe, cancelDeviceLightRecipe, releaseDeviceLightPriority } from './ramRecipe.ts';
import type { NordicInlineLedRecipe } from './ramRecipe.ts';
import { PlayModeShellReader, isPlayModeShellQuery } from './playModeShell.ts';
import { serviceCommands, responseView, decodeServiceReading, serviceCompatibleQuery } from './service.ts';
import type { ServiceRead, ServiceState, ServiceReading } from './service.ts';
import { capability } from './registry.ts';
import { decodeNotification } from './notifications.ts';
import { ResourceArbiter, commandClaim } from './ownership.ts';
import type { Resource } from './ownership.ts';
import { validateCommand, stopPlan, requiresMotionArm } from './gates.ts';
import type { CommandAccess, DriveMode } from './gates.ts';
export const UUIDS = {
    api: '00010002-574f-4f20-5370-6865726f2121',
    information: '00020004-574f-4f20-5370-6865726f2121',
    initialization: '00020005-574f-4f20-5370-6865726f2121',
    control: '00020002-574f-4f20-5370-6865726f2121',
    shell: '00010003-574f-4f20-5370-6865726f2121'
} as const;
export interface CharacteristicRef {
    service: string;
    characteristic: string;
}
/** subscribe resolves only after local delivery AND CCCD enablement complete. */
export interface BleTransport {
    discover(): Promise<CharacteristicRef[]>;
    read(ref: CharacteristicRef): Promise<Uint8Array>;
    write(ref: CharacteristicRef, data: Uint8Array, withResponse: boolean): Promise<void>;
    subscribe(ref: CharacteristicRef, listener: (data: Uint8Array) => void): Promise<() => void>;
    disconnect(): Promise<void>;
    emergencyWrite?(ref: CharacteristicRef, frames: Uint8Array[]): Promise<void>;
    priorityWrite?(ref: CharacteristicRef, frames: Uint8Array[]): Promise<void>;
}
export type ConnectionState = 'disconnected' | 'discovering' | 'initializing' | 'awaiting-restart' | 'corrupt' | 'ready' | 'failed' | 'sleeping';
export interface ControllerOptions {
    timeoutMs?: number;
    onState?: (state: ConnectionState) => void;
    onPacket?: (packet: Packet) => void;
    onResponse?: (packet: Packet) => void;
    onError?: (error: Error) => void;
}
export function applicationState(info: Uint8Array): 'restart' | 'corrupt' | 'running' {
    if (info.length < 8)
        return 'restart';
    if (info[6] === 1 || (info[6] === 0 && info[3] === 1))
        return 'corrupt';
    return (info[6] === 0 ? info[4] : info[7]) === 2 ? 'running' : 'restart';
}
/** An actual checksum-validated, matching droid error response (never a transport error). */
export class DroidResponseError extends Error {
    readonly packet: Packet;
    constructor(packet: Packet) {
        super(`Droid error ${packet.error} (${packet.did}/${packet.cid})`);
        this.name = 'DroidResponseError';
        this.packet = packet;
    }
}
export class R2Controller {
    readonly transport: BleTransport;
    private options: ControllerOptions;
    state: ConnectionState = 'disconnected';
    private decoder = new PacketDecoder();
    private refs: CharacteristicRef[] = [];
    private cleanup: (() => void)[] = [];
    private epoch = 0;
    private sequence = 1;
    private queueGeneration = 0;
    private retired = new Set<number>();
    private driveMode: DriveMode = 'heading';
    private motionLatch = true;
    private emergencyInFlight = false;
    private unconfirmedDriveStop = false;
    private stopRecovery = false;
    get driveStopUnconfirmed() { return this.unconfirmedDriveStop; }
    private checkDriveStop(command: Command) {
        if (this.unconfirmedDriveStop && command.did === 22 && [1, 7, 8].includes(command.cid) && command.data.some(value => value !== 0))
            throw new Error("Drive stop is unconfirmed. Retry STOP before wheel driving.");
    }
    private resources = new ResourceArbiter();
    private serviceAccess: ServiceState = 'locked';
    private serviceBusy = false;
    private serviceGeneration = 0;
    private serviceChallenge?: number;
    private writeTail: Promise<unknown> = Promise.resolve();
    private tail: Promise<unknown> = Promise.resolve();
    private pending?: {
        did: number;
        cid: number;
        seq: number;
        resolve: (p: Packet) => void;
        reject: (e: Error) => void;
    };
    private deviceRamVerified = false;
    private deviceRamTouched = false;
    private deviceRamRelease?: Promise<void>;
    async verifyDeviceRamFirmware(): Promise<void> {
        if (this.deviceRamVerified)
            return;
        const epoch = this.epoch, packet = await this.probe(commands.identity(0));
        const expected = [0, 7, 0, 0, 0, 101];
        if (packet.data.length !== expected.length || !packet.data.every((v, i) => v === expected[i]))
            throw new Error('Device-RAM lights require verified Nordic 7.0.101 firmware');
        if (epoch !== this.epoch || this.state !== 'ready')
            throw new Error('Connection changed');
        this.deviceRamVerified = true;
    }
    async startDeviceLightRecipe(recipe: NordicInlineLedRecipe): Promise<number> {
        if (this.deviceRamRelease)
            throw new Error('Device light cleanup is still in progress');
        if (!this.deviceRamVerified)
            throw new Error('Device-RAM firmware must be verified first');
        const compiled = compileNordicInlineLedRecipe(recipe);
        await this.enqueue(compiled.command, {}, false, false, true);
        return compiled.durationMs;
    }
    cancelDeviceLightRecipe(): Promise<void> {
        if (this.deviceRamRelease)
            return this.deviceRamRelease;
        const work = this.releaseDeviceLightRecipe();
        this.deviceRamRelease = work;
        const clear = () => {
            if (this.deviceRamRelease === work)
                this.deviceRamRelease = undefined;
        };
        void work.then(clear, clear);
        return work;
    }
    private async releaseDeviceLightRecipe(): Promise<void> {
        if (!this.deviceRamVerified)
            throw new Error('Device-RAM firmware must be verified first');
        const epoch = this.epoch, generation = this.queueGeneration;
        await this.enqueue(cancelDeviceLightRecipe(), {}, false, false, true);
        await this.enqueue(releaseDeviceLightPriority(), {}, false, false, true);
        await new Promise<void>(resolve => setTimeout(resolve, 1600));
        if (epoch !== this.epoch || generation !== this.queueGeneration)
            throw new Error('Device light release canceled');
        this.resources.confirmDeviceLightsReleased();
        this.deviceRamTouched = false;
    }
    private safetyCommands() {
        return [...(this.deviceRamTouched ? [cancelDeviceLightRecipe(), releaseDeviceLightPriority()] : []), ...stopPlan(this.driveMode)];
    }
    private playModeReader?: PlayModeShellReader;
    private playModeShellOnly = false;
    private packetObservers?: Set<(packet: Packet) => void>;
    async readPlayMode(): Promise<number> {
        if (this.state !== 'ready' || this.serviceAccess !== 'locked')
            throw new Error('Ready control session required');
        if (!this.playModeShellOnly) {
            try {
                const packet = await this.probe(commands.getPlayMode());
                if (packet.data.length !== 2)
                    throw new Error('Malformed play-mode reply');
                return new DataView(packet.data.buffer, packet.data.byteOffset, 2).getUint16(0, false);
            }
            catch (error) {
                if (!(error instanceof DroidResponseError) || error.packet.error !== 3)
                    throw error;
                this.playModeShellOnly = true;
            }
        }
        const reader = this.playModeReader ??= new PlayModeShellReader();
        const reading = await reader.read({
            command: c => this.command(c),
            subscribe: listener => {
                const observers = this.packetObservers ??= new Set();
                observers.add(listener);
                return () => {
                    observers.delete(listener);
                };
            }
        }, { timeoutMs: this.options.timeoutMs ?? 5000 });
        return reading.mode;
    }
    private unsupportedModes = new Set<string>();
    get hasOngoingActivity() {
        return this.resources.hasOngoingActivity;
    }
    get unsupportedStopModes() {
        return [...this.unsupportedModes];
    }
    constructor(transport: BleTransport, options: ControllerOptions = {}) {
        this.transport = transport;
        this.options = options;
    }
    /** Development hot adoption preserves every transport, parser, queue and safety
     * field. Existing in-flight work finishes on its original promise chain. */
    static adoptRuntimePolicy(controller: R2Controller, onPacket?: ControllerOptions['onPacket'], onResponse?: ControllerOptions['onResponse']): void {
        if (controller.motionArmed || controller.emergencyInFlight)
            throw new Error('Runtime policy adoption requires a disarmed controller after STOP');
        Object.setPrototypeOf(controller, R2Controller.prototype);
        Object.setPrototypeOf(controller.resources, ResourceArbiter.prototype);
        controller.options = { ...controller.options, ...(onPacket ? { onPacket } : {}), ...(onResponse ? { onResponse } : {}) };
    }
    private setState(state: ConnectionState) {
        this.state = state;
        this.options.onState?.(state);
    }
    private ref(uuid: string) {
        const found = this.refs.find(r => r.characteristic.toLowerCase() === uuid);
        if (!found)
            throw new Error(`Required characteristic missing: ${uuid}`);
        return found;
    }
    private async bounded<T>(promise: Promise<T>, epoch = this.epoch): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([promise, new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Bluetooth operation timed out')), this.options.timeoutMs ?? 5000);
                })]);
            if (epoch !== this.epoch)
                throw new Error('Connection changed');
            return result;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async initialize(): Promise<'ready' | 'awaiting-restart' | 'corrupt'> {
        if (!['disconnected', 'failed'].includes(this.state))
            throw new Error('Disconnect before reinitializing');
        this.disconnected();
        const epoch = this.epoch;
        this.setState('discovering');
        try {
            this.refs = await this.bounded(this.transport.discover(), epoch);
            this.setState('initializing');
            await this.bounded(this.transport.write(this.ref(UUIDS.initialization), Uint8Array.from('usetheforce...band', c => c.charCodeAt(0)), true), epoch);
            this.cleanup.push(await this.bounded(this.transport.subscribe(this.ref(UUIDS.control), () => { }), epoch));
            const info = await this.bounded(this.transport.read(this.ref(UUIDS.information)), epoch),
                status = applicationState(info);
            if (status === 'corrupt') {
                this.setState('corrupt');
                return 'corrupt';
            }
            if (status === 'restart') {
                const control = this.ref(UUIDS.control);
                this.setState('awaiting-restart');
                try {
                    await this.bounded(this.transport.write(control, Uint8Array.of(0x1e), true), epoch);
                }
                catch (error) {
                    if (epoch === this.epoch)
                        throw error; /* Expected application jump may disconnect before write completion. */
                }
                return 'awaiting-restart';
            }
            this.cleanup.push(await this.bounded(this.transport.subscribe(this.ref(UUIDS.api), bytes => {
                if (epoch === this.epoch)
                    this.receive(bytes);
            }), epoch));
            await this.bounded(new Promise<void>(resolve => setTimeout(resolve, 100)), epoch);
            await this.exchange(commands.wake(), 0, epoch);
            this.setState('ready');
            return 'ready';
        }
        catch (error) {
            if (epoch === this.epoch)
                this.setState('failed');
            throw error;
        }
    }
    private receive(bytes: Uint8Array) {
        let revoked = this.state === 'disconnected';
        for (const packet of this.decoder.push(bytes)) {
            // Already-decoded frames still reach telemetry after sleep revokes this
            // session. They cannot acknowledge commands or trigger further lifecycle work.
            if (revoked) {
                this.options.onPacket?.(packet);
                continue;
            }
            const wait = this.pending;
            if ((packet.flags & 1) && wait && wait.did === packet.did && wait.cid === packet.cid && wait.seq === packet.seq) {
                this.pending = undefined;
                if (packet.error)
                    wait.reject(new DroidResponseError(packet));
                else {
                    wait.resolve(packet);
                    this.options.onResponse?.(packet);
                }
            }
            this.options.onPacket?.(packet);
            for (const listener of this.packetObservers ?? [])
                listener(packet);
            const event = decodeNotification(packet);
            if (event?.type === 'did-sleep' || event?.type === 'will-sleep') {
                this.handleSleep(event.type === 'will-sleep');
                revoked = this.state === 'disconnected';
            }
        }
    }
    private handleSleep(willSleep: boolean) {
        if (!willSleep) {
            if (this.state !== 'sleeping')
                this.setState('sleeping');
            this.disconnected('Droid did sleep');
            void this.transport.disconnect().catch(error => this.options.onError?.(error));
            return;
        }
        if (this.state === 'sleeping')
            return;
        // Will-sleep is the eight-second inactivity warning, not completion.
        // Stopping held host activity retains BLE for the later firmware sleep
        // sequence and its did-sleep notification. Explicit sleep need not emit this.
        void this.emergencyStop().catch(error => this.options.onError?.(error));
        this.setState('sleeping');
    }
    private writeFrame(frame: Uint8Array, epoch: number) {
        const generation = this.queueGeneration;
        const run = this.writeTail.then(async () => {
            if (epoch !== this.epoch)
                throw new Error('Connection changed');
            for (let offset = 0; offset < frame.length; offset += 20) {
                if (generation !== this.queueGeneration)
                    throw new Error('Write cancelled by STOP');
                await this.bounded(this.transport.write(this.ref(UUIDS.api), frame.slice(offset, offset + 20), true), epoch);
            }
        });
        this.writeTail = run.catch(() => { });
        return run;
    }
    private nextSequence() {
        for (let n = 0; n < 254; n++) {
            const seq = this.sequence;
            this.sequence = this.sequence % 254 + 1;
            if (!this.retired.has(seq))
                return seq;
        }
        throw new Error('Reconnect required: response sequences exhausted');
    }
    private async exchange(command: Command, seq: number, epoch: number): Promise<Packet> {
        let rejectResponse: (e: Error) => void = () => { };
        const response = new Promise<Packet>((resolve, reject) => {
            rejectResponse = reject;
            this.pending = {
                ...command, seq, resolve, reject
            };
        });
        // Rejection handling precedes asynchronous writes because disconnect can reject immediately.
        const settled = response.then(value => ({ value }), error => ({ error }));
        try {
            const frame = encodePacket({ ...command, flags: 0x0a, seq });
            await this.writeFrame(frame, epoch);
            const result = await this.bounded(settled, epoch);
            if ('error' in result)
                throw result.error;
            return result.value;
        }
        catch (error) {
            rejectResponse(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        finally {
            if (this.pending?.seq === seq)
                this.pending = undefined;
        }
    }
    get motionArmed() {
        return !this.motionLatch && this.state === 'ready';
    }
    /** Motion arming requires a fresh user activation, never a retained input tick. */
    armMotion() {
        if (this.serviceBusy || this.serviceAccess !== 'locked')
            throw new Error('Exit service session before motion');
        if (this.state !== 'ready')
            throw new Error('Droid is not ready');
        this.motionLatch = false;
    }
    command(command: Command, access: CommandAccess = {}): Promise<Packet> {
        return this.enqueue(command, access, false);
    }
    /** Optional read-only compatibility checks; unsupported replies are warnings, link failures remain fatal. */
    probe(command: Command): Promise<Packet> {
        if (!(
            (command.did === 0x11 && [0, 3].includes(command.cid))
            || (command.did === 0x13 && [3, 4].includes(command.cid))
            || (command.did === 0x12 && command.cid === 0x27)
            || (command.did === 0x17 && [0x2e, 0x30].includes(command.cid))
        ) || command.data.length !== 0)
            return Promise.reject(new Error('Not an optional compatibility query'));
        return this.enqueue(command, {}, true);
    }
    private enqueue(command: Command, access: CommandAccess, compatibilityProbe: boolean, managedService = false, managedDeviceRam = false): Promise<Packet> {
        // A private payload copy prevents callers from mutating a validated queued command.
        command = { ...command, data: command.data.slice() };
        try {
            const unmanagedDeviceRamCommand = command.did === 23 && [26, 40].includes(command.cid) && !managedDeviceRam;
            if (unmanagedDeviceRamCommand) {
                throw new Error('Use the managed device-RAM light workflow');
            }
            if (this.serviceBusy && !managedService) {
                throw new Error('Service workflow is in progress');
            }
            validateCommand(command, access);
            this.checkDriveStop(command);
            const key = [command.did, command.cid].map(v => v.toString(16).padStart(2, '0')).join('/');
            const requiresServiceSession = capability(key)?.serviceSession
                && !isPlayModeShellQuery(command)
                && !managedService
                && this.serviceAccess === 'locked';
            if (requiresServiceSession) {
                throw new Error('Open an explicit service session first');
            }
            const unmanagedServiceTransition = command.did === 31 && [19, 20, 21].includes(command.cid) && !managedService;
            if (unmanagedServiceTransition) {
                throw new Error('Use the managed service session workflow');
            }
            const serviceBlocksCommand = this.serviceAccess !== 'locked' && !managedService && !serviceCompatibleQuery(command);
            if (serviceBlocksCommand) {
                throw new Error('Exit service session before normal commands');
            }
            if (this.motionLatch && requiresMotionArm(command)) {
                throw new Error('Motion stopped: explicitly rearm before moving');
            }
        }
        catch (error) {
            return Promise.reject(error);
        }
        const epoch = this.epoch, generation = this.queueGeneration;
        const run = this.tail.then(async () => {
            if (epoch !== this.epoch || this.state !== 'ready')
                throw new Error('Droid is not ready');
            if (generation !== this.queueGeneration)
                throw new Error('Command cancelled by STOP');
            this.checkDriveStop(command);
            if (this.motionLatch && requiresMotionArm(command))
                throw new Error('Motion stopped: explicitly rearm before moving');
            try {
                if (this.serviceAccess !== 'locked' && !managedService && !serviceCompatibleQuery(command))
                    throw new Error('Exit service session before normal commands');
                let conflict = this.resources.conflicts(command);
                const stanceNeedsReadback = conflict?.requested === 'manual drive'
                    && conflict.owners.length === 1
                    && conflict.owners[0] === 'manual stance'
                    && this.resources.pendingStationaryStance !== undefined;
                if (stanceNeedsReadback) {
                    // Stance ACK means accepted, not finished. Firmware GetLegAction reports
                    // Transitioning (4) separately from completed two/three-leg positions.
                    const reading = await this.exchange(commands.getLegAction(), this.nextSequence(), epoch);
                    if (epoch !== this.epoch || generation !== this.queueGeneration || this.motionLatch)
                        throw new Error('Drive handoff cancelled');
                    if (reading.data.length === 1)
                        this.resources.confirmStationaryStance(reading.data[0]);
                    conflict = this.resources.conflicts(command);
                }
                if (conflict) {
                    if (!access.replace)
                        throw conflict;
                    const scope = this.stopRecovery ? commandClaim(command)?.resources.filter(resource => !this.unconfirmedDriveStop || resource !== 'drive') : undefined;
                    await this.stopSources(epoch, generation, scope);
                    if (epoch !== this.epoch || generation !== this.queueGeneration)
                        throw new Error('Replacement cancelled');
                    if (scope) this.resources.confirmStopped(scope);
                    else this.resources.clear();
                }
                if (command.did === 0x16 && [1, 7, 8].includes(command.cid))
                    this.driveMode = command.cid === 8 ? 'tank' : command.cid === 1 ? 'raw' : 'heading';
                if (command.did === 23 && command.cid === 26)
                    this.deviceRamTouched = true;
                const packet = await this.exchange(command, this.nextSequence(), epoch);
                if (epoch !== this.epoch || generation !== this.queueGeneration)
                    throw new Error('Command cancelled by STOP');
                this.resources.accept(command);
                // The completion query also used by path preparation confirms the stance;
                // the stance command ACK alone does not prove the transition has finished.
                if (command.did === 23 && command.cid === 37 && packet.data.length === 1)
                    this.resources.confirmStationaryStance(packet.data[0]);
                return packet;
            }
            catch (error) {
                this.commandFailure(error, epoch, generation, compatibilityProbe);
                throw error;
            }
        });
        this.tail = run.catch(() => { });
        return run;
    }
    get serviceState(): ServiceState {
        return this.serviceAccess;
    }
    get serviceTransitionPending() {
        return this.serviceBusy;
    }
    private checkServiceTransition(generation: number, epoch: number) {
        if (generation !== this.serviceGeneration || epoch !== this.epoch || this.state !== 'ready')
            throw new Error('Service workflow cancelled by STOP or connection change');
    }
    private async failClosedService(reason: string) {
        this.disconnected(reason);
        try {
            await this.transport.disconnect();
        }
        catch (error) {
            this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
    }
    /** A user-requested service session stops ordinary sources and obtains a fresh challenge before vetted reads. */
    async beginServiceSession(): Promise<{
        challenge: number;
        response: number;
    }> {
        if (this.serviceAccess !== 'locked' || this.serviceBusy)
            throw new Error('Exit the existing service session first');
        const generation = ++this.serviceGeneration, epoch = this.epoch;
        this.serviceBusy = true;
        try {
            await this.replaceSources();
            this.checkServiceTransition(generation, epoch);
            const packet = await this.enqueue(serviceCommands.challenge(), { serviceSession: true }, false, true);
            this.checkServiceTransition(generation, epoch);
            const challenge = responseView(packet, 31, 19, 4).getUint32(0, false);
            const responseCommand = serviceCommands.enter(challenge);
            this.serviceChallenge = challenge;
            this.serviceAccess = 'readable';
            return { challenge, response: new DataView(responseCommand.data.buffer).getUint32(0, false) };
        }
        finally {
            if (generation === this.serviceGeneration)
                this.serviceBusy = false;
        }
    }
    /** Separate user confirmation; restricted/destructive commands remain blocked even after ACK. */
    async enterServiceSession(): Promise<void> {
        if (this.serviceBusy || this.serviceAccess !== 'readable' || this.serviceChallenge === undefined)
            throw new Error('Obtain a fresh service challenge first');
        const challenge = this.serviceChallenge;
        this.serviceChallenge = undefined;
        const generation = ++this.serviceGeneration, epoch = this.epoch;
        this.serviceBusy = true;
        try {
            const packet = await this.enqueue(serviceCommands.enter(challenge), { serviceSession: true }, false, true);
            this.checkServiceTransition(generation, epoch);
            responseView(packet, 31, 20, 0);
            this.serviceAccess = 'unlocked';
        }
        catch (error) {
            if (generation === this.serviceGeneration && epoch === this.epoch)
                await this.failClosedService('Service entry unconfirmed; connection closed');
            throw error;
        }
        finally {
            if (generation === this.serviceGeneration)
                this.serviceBusy = false;
        }
    }
    async readService(kind: ServiceRead, index = 0): Promise<ServiceReading> {
        if (this.serviceAccess === 'locked')
            throw new Error('Open an explicit service session first');
        const generation = this.serviceGeneration, epoch = this.epoch;
        const packet = await this.enqueue(serviceCommands.read(kind, index), { serviceSession: true }, false);
        this.checkServiceTransition(generation, epoch);
        return decodeServiceReading(kind, packet, index);
    }
    /** Leaving Diagnostics requires an exit ACK; failure revokes local access and propagates. */
    async endServiceSession(): Promise<void> {
        if (this.serviceBusy) {
            // An entry may already have reached firmware before its GATT completion callback.
            // Priority exit + disconnection revoke local access without pretending exit was ACKed.
            try {
                await this.emergencyStop();
            }
            finally {
                await this.failClosedService('Service transition cancelled; exit unconfirmed');
            }
            throw new Error('Service transition cancelled; connection closed and factory exit unconfirmed');
        }
        if (this.serviceAccess === 'locked')
            return;
        const generation = ++this.serviceGeneration, epoch = this.epoch;
        this.serviceBusy = true;
        try {
            await this.replaceSources();
            this.checkServiceTransition(generation, epoch);
            const packet = await this.enqueue(serviceCommands.exit(), { serviceSession: true }, false, true);
            this.checkServiceTransition(generation, epoch);
            responseView(packet, 31, 21, 0);
        }
        catch (error) {
            if (generation === this.serviceGeneration && epoch === this.epoch)
                await this.failClosedService('Service exit unconfirmed; connection closed');
            throw error;
        }
        finally {
            if (generation === this.serviceGeneration) {
                this.serviceBusy = false;
                this.serviceAccess = 'locked';
                this.serviceChallenge = undefined;
                this.motionLatch = true;
            }
        }
    }
    /** Explicitly confirmed source replacement without replaying a retained movement target.
     * Completes only after each stop response; a fresh gesture must arm subsequent motion. */
    async replaceSources(): Promise<void> {
        this.motionLatch = true;
        if (this.state !== 'ready' || this.emergencyInFlight)
            throw new Error('Droid is not ready for source replacement');
        const epoch = this.epoch, generation = ++this.queueGeneration;
        if (this.pending) {
            this.retired.add(this.pending.seq);
            this.pending.reject(new Error('Command cancelled by source replacement'));
            this.pending = undefined;
        }
        const run = this.writeTail.then(async () => {
            try {
                await this.stopSources(epoch, generation);
                if (epoch !== this.epoch || generation !== this.queueGeneration)
                    throw new Error('Replacement cancelled');
                this.resources.clear();
                this.unconfirmedDriveStop = false;
                this.stopRecovery = false;
            }
            catch (error) {
                this.commandFailure(error, epoch, generation);
                throw error;
            }
        });
        this.tail = run.catch(() => { });
        await run;
    }
    private commandFailure(error: unknown, epoch: number, generation: number, compatibilityProbe = false) {
        if (epoch !== this.epoch || generation !== this.queueGeneration)
            return;
        if (error instanceof DroidResponseError && (!compatibilityProbe || [1, 2, 3].includes(error.packet.error ?? 0))) {
            // A matching command rejection preserves the connection state.
            // The proven transport remains connected while motion and uncertain source ownership are revoked.
            this.motionLatch = true;
            this.resources.reset();
        }
        else if (!(error instanceof Error && error.name === 'ResourceConflictError')) {
            this.setState('failed');
            this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
    }
    private async stopExchange(stop: Command, epoch: number, generation: number) {
        const deadline = Date.now() + (this.options.timeoutMs ?? 5000);
        for (;;) {
            if (epoch !== this.epoch || generation !== this.queueGeneration)
                throw new Error('Replacement cancelled');
            try {
                return await this.exchange(stop, this.nextSequence(), epoch);
            }
            catch (error) {
                // Firmware drive handlers return 8 after starting the required stance
                // transition. Only this zero-output request is retried; the pending action is never replayed.
                if (!(
                    error instanceof DroidResponseError
                    && error.packet.error === 8
                    && stop.did === 22
                    && [1, 7, 8].includes(stop.cid)
                    && stop.data.every(value => value === 0)
                ) || Date.now() >= deadline)
                    throw error;
                await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
            }
        }
    }
    private async stopSources(epoch: number, generation: number, scope?: readonly Resource[]) {
        const affects = (stop: Command): readonly Resource[] => {
            if (stop.did === 22) return ['drive'];
            if (stop.did === 26 && stop.cid === 10) return ['audio'];
            if (stop.did === 23 && stop.cid === 13) return ['stance'];
            if (stop.did === 23 && stop.cid === 41) return ['dome'];
            if (stop.did === 23 && [26, 40].includes(stop.cid)) return ['lights'];
            return ['drive', 'dome', 'stance', 'lights', 'audio', 'behavior'];
        };
        const failures: {error: DroidResponseError; resources: readonly Resource[]}[] = [];
        const releaseLights = this.deviceRamTouched && (!scope || scope.includes('lights'));
        for (const stop of this.safetyCommands()) {
            if (scope && !affects(stop).some(resource => scope.includes(resource))) continue;
            if (epoch !== this.epoch || generation !== this.queueGeneration)
                throw new Error('Replacement cancelled');
            try {
                await this.stopExchange(stop, epoch, generation);
            }
            catch (error) {
                // A matching bad-CID response proves that this optional mode control does
                // not exist on this firmware. Retain other rejections by resource,
                // and continue so an audio error cannot prevent wheel zero.
                if (epoch !== this.epoch || generation !== this.queueGeneration) throw error;
                this.stopRecovery = true;
                if (!(error instanceof DroidResponseError)) {
                    this.unconfirmedDriveStop = true;
                    throw error;
                }
                if (error.packet.error === 2 && stop.did === 23 && [10, 45, 47].includes(stop.cid) && stop.data.length === 1 && stop.data[0] === 0)
                    this.unsupportedModes.add(stop.cid === 10 ? 'idle animations' : stop.cid === 45 ? 'trophy mode' : 'droid interaction');
                else failures.push({error, resources: affects(stop)});
            }
        }
        if (epoch !== this.epoch || generation !== this.queueGeneration) throw new Error('Replacement cancelled');
        if (!scope || scope.includes('drive'))
            this.unconfirmedDriveStop = failures.some(failure => failure.resources.includes('drive'));
        if (failures.length) throw failures[0].error;
        if (releaseLights) {
            await new Promise<void>(resolve => setTimeout(resolve, 1600));
            if (epoch !== this.epoch || generation !== this.queueGeneration)
                throw new Error('Device light release canceled');
            this.deviceRamTouched = false;
        }
    }
    /** Native's independently bounded pulse has ended and already attempted wheel zero.
     * Fencing JS intent avoids a priority write that could collide with the native batch.
     * The GATT write barrier remains intact without waiting for the cancelled API response. */
    nativeDrivePulseEnded(reason = 'Native pulse ended'): void {
        this.motionLatch = true;
        // A late native event must not cancel a fresh initialization exchange.
        if (this.state !== 'ready' && this.state !== 'failed')
            return;
        this.queueGeneration++;
        if (this.pending) {
            this.retired.add(this.pending.seq);
            this.pending.reject(new Error(reason));
            this.pending = undefined;
        }
        this.tail = this.writeTail.catch(() => { });
    }
    /** Pointer/key release: cancel stale intent and zero only the active drive mode.
     * Leaves ongoing performances/audio and the transport connection intact. */
    async releaseDrive(): Promise<void> {
        this.motionLatch = true;
        if (this.emergencyInFlight)
            throw new Error('Emergency STOP in progress');
        if (!['ready', 'failed'].includes(this.state))
            return;
        const epoch = this.epoch, generation = ++this.queueGeneration;
        if (this.pending) {
            this.retired.add(this.pending.seq);
            this.pending.reject(new Error('Command cancelled by drive release'));
            this.pending = undefined;
        }
        const zero = this.driveMode === 'tank' ? commands.tank(0, 0) : this.driveMode === 'raw' ? commands.rawMotors(0, 0, 0, 0) : commands.stop();
        const frames = [encodePacket({ ...zero, seq: 255, flags: 0x08 })];
        const barrier = this.transport.priorityWrite ? this.bounded(this.transport.priorityWrite(this.ref(UUIDS.api), frames), epoch) : this.writeTail.then(async () => {
            for (const frame of frames)
                await this.writeFrame(frame, epoch);
        });
        // Priority zero is immediate. A separate matching reply establishes ownership
        // release; successful GATT delivery alone must not clear the manual owner.
        const run = barrier.then(async () => {
            await this.stopExchange(zero, epoch, generation);
            if (epoch !== this.epoch || generation !== this.queueGeneration)
                throw new Error('Drive release cancelled');
            this.resources.accept(zero);
        });
        this.tail = run.catch(() => { });
        try {
            await run;
        }
        catch (error) {
            if (epoch === this.epoch && generation === this.queueGeneration) {
                this.unconfirmedDriveStop = true;
                this.stopRecovery = true;
            }
            throw error;
        }
    }
    /** Cancels stale intent. Cannot interrupt an already submitted GATT transaction or guarantee physical stop. */
    async emergencyStop(): Promise<void> {
        const closeService = this.serviceAccess !== 'locked' || this.serviceBusy;
        this.serviceGeneration++;
        this.serviceBusy = false;
        this.serviceAccess = 'locked';
        this.serviceChallenge = undefined;
        this.motionLatch = true;
        this.resources.reset();
        if (!['ready', 'failed'].includes(this.state))
            return;
        this.emergencyInFlight = true;
        const epoch = this.epoch;
        this.queueGeneration++;
        if (this.pending) {
            this.retired.add(this.pending.seq);
            this.pending.reject(new Error('Command cancelled by STOP'));
            this.pending = undefined;
        }
        // Sequence 255 is reserved for response-free safety frames, including native watchdogs.
        // No expected response exists, so repeated safety frames cannot acknowledge a drive command.
        const frames = [...this.safetyCommands(), ...(closeService ? [serviceCommands.exit()] : [])].map(command => encodePacket({ ...command, seq: 255, flags: 0x08 }));
        const barrier = this.transport.emergencyWrite ? this.bounded(this.transport.emergencyWrite(this.ref(UUIDS.api), frames), epoch) : this.writeTail.then(async () => {
            for (const frame of frames)
                await this.writeFrame(frame, epoch);
        });
        this.tail = barrier.catch(() => { });
        try {
            await barrier;
        }
        catch (error) {
            if (epoch === this.epoch) {
                this.unconfirmedDriveStop = true;
                this.stopRecovery = true;
            }
            throw error;
        }
        finally {
            this.emergencyInFlight = false;
        }
    }
    /** Platform disconnect cleanup clears stale replies, queues and stream fragments. */
    disconnected(reason = 'Bluetooth disconnected') {
        this.deviceRamVerified = false;
        this.deviceRamTouched = false;
        this.deviceRamRelease = undefined;
        this.playModeReader?.reset();
        this.playModeShellOnly = false;
        this.packetObservers?.clear();
        this.motionLatch = true;
        this.unsupportedModes.clear();
        this.serviceGeneration++;
        this.serviceBusy = false;
        this.serviceAccess = 'locked';
        this.serviceChallenge = undefined;
        this.emergencyInFlight = false;
        this.unconfirmedDriveStop = false;
        this.stopRecovery = false;
        this.resources.reset();
        this.epoch++;
        this.queueGeneration++;
        this.pending?.reject(new Error(reason));
        this.pending = undefined;
        for (const unsubscribe of this.cleanup.splice(0)) {
            try {
                unsubscribe();
            }
            catch { }
        }
        this.decoder.reset();
        this.refs = [];
        this.sequence = 1;
        this.retired.clear();
        this.driveMode = 'heading';
        this.writeTail = Promise.resolve();
        this.tail = Promise.resolve();
        this.setState('disconnected');
    }
    async disconnect() {
        if (this.serviceAccess !== 'locked' && this.state === 'ready') {
            try {
                await this.endServiceSession();
            }
            catch (error) {
                this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
            }
        }
        this.disconnected();
        await this.transport.disconnect();
    }
}
