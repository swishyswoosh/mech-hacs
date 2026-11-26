import type { ControllerSession } from "../app/session/ControllerSession.ts";
import type { AppSnapshot, LocalSource, SessionSnapshot } from "../app/session/types.ts";
import type { Command, CommandAccess } from "../core/index.ts";
import { SessionStore } from "../app/session/store.ts";
import { ManualMotionLease } from "../app/session/ManualMotion.ts";
import { TelemetryEventStream } from "../core/telemetryEvents.ts";
import { sounds } from "../core/catalogs.ts";
import { commands } from "../core/commands.ts";
import { arcade } from "../core/drive.ts";
import { RemoteMotion } from "./remoteMotion.ts";
import { requestId } from "./requestId.ts";
type CatalogItem = {
  id: string;
  available: boolean;
  effects: string[];
  firmware_id?: number;
  sector?: number;
};
type Operation = {
  operation_id: string;
  state: string;
  reason?:
    | string
    | {
        message?: string;
      };
  error?: {
    message?: string;
  };
};
type Preferences = {
  revision: number;
  values: Record<string, string>;
};
type Options = {
  base?: string;
  fetch?: typeof fetch;
  clientId?: string;
  subscribeChanges?: (changed: () => void) => () => void;
};
type RefreshKind = "snapshot" | "shared";
type RefreshWork = {
  current: () => boolean;
  promise: Promise<void>;
};
type RefreshSlot = { active?: RefreshWork; queued?: RefreshWork };
class RemoteRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const unavailable = () => new Error("This capability is unavailable in remote control mode.");
/** The service owns the transport and effect admission. Failed client releases
 * remain blocked until an explicit STOP succeeds. */
export class RemoteSession implements ControllerSession {
  readonly mode = "remote" as const;
  motionAvailable = false;
  private motionSupported = false;
  private telemetryAvailable = false;
  private lightFramesAvailable = false;
  private lightFrameToken?: string;
  private cockpitObservers = 0;
  private sensorsRequested = false;
  private motion: RemoteMotion;
  private drivePoint?: [number, number];
  private driveSpeed = 25;
  readonly manualMotion = new ManualMotionLease();
  readonly clientId: string;
  readonly base: string;
  private fetcher: typeof fetch;
  private snapshot: SessionSnapshot = new SessionStore({
    state: "disconnected",
    detail: "Choose an enrolled droid.",
    packets: [],
  }).getSnapshot();
  private listeners = new Set<() => void>();
  readonly store = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener: () => void) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };
  private telemetry = new TelemetryEventStream();
  private cancels = new Set<() => void>();
  private csrf = "";
  private droid?: string;
  private selectionGeneration = 0;
  private selectionPending?: number;
  private selectionStop?: Promise<void>;
  private refreshGeneration = 0;
  private sharedRefreshGeneration = 0;
  private refreshes = new Map<RefreshKind, RefreshSlot>();
  private preferences: Preferences = { revision: 0, values: {} };
  private preferenceWriteRevision?: number;
  private preferenceConflictGeneration = 0;
  private saveQueue: Promise<void> = Promise.resolve();
  private focusPaused = false;
  private focusGeneration = 0;
  private activityGeneration = 0;
  private running = false;
  private focusStop?: Promise<void>;
  private stopFailure?: string;
  private get controlBlocked() { return !!this.stopFailure && !this.snapshot.stopFailure; }
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatGeneration = 0;
  private stream?: EventSource;
  private subscribeChanges?: Options["subscribeChanges"];
  private unsubscribeChanges?: () => void;
  private catalogs = new Map<string, CatalogItem[]>();
  constructor(options: Options = {}) {
    this.base = options.base ?? new URL("api/v1/", document.baseURI).href;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.clientId = options.clientId ?? requestId();
    this.subscribeChanges = options.subscribeChanges;
    this.motion = new RemoteMotion((path, method, body) => this.request(path, method, body), this.clientId, error => this.fail(`Motion STOP required: ${String(error)}. Connection retained.`), () => this.cancelLocalSources());
  }
  /** Retained HMR instances do not run a new constructor. Migrate local fences
   * without replacing the connection identity or clearing a failed STOP. */
  adoptRetainedState() {
    this.focusGeneration ??= 0;
    this.selectionGeneration ??= 0;
    this.refreshGeneration = (this.refreshGeneration ?? 0) + 1;
    this.sharedRefreshGeneration = (this.sharedRefreshGeneration ?? 0) + 1;
    this.refreshes = new Map();
    this.preferenceWriteRevision ??= this.preferences.revision;
    this.running ??= !!(this.stream || this.heartbeat);
    this.motionAvailable ??= false;
    this.motionSupported ??= this.motionAvailable;
    this.telemetryAvailable ??= false;
    this.cockpitObservers ??= 0;
    this.sensorsRequested ??= false;
    this.driveSpeed ??= 25;
    this.motion ??= new RemoteMotion((path, method, body) => this.request(path, method, body), this.clientId, error => this.fail(`Motion STOP required: ${String(error)}. Connection retained.`), () => this.cancelLocalSources());
  }
  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    extra?: HeadersInit,
  ): Promise<T> {
    const response = await this.fetcher(new URL(path, this.base), {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(method !== "GET" ? { "X-CSRF-Token": this.csrf } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(path === "ui/release" ? { keepalive: true } : {}),
    });
    const value = await response.json();
    if (!response.ok)
      throw new RemoteRequestError(
        response.status,
        value.error?.message ?? value.message ?? `Service request failed (${response.status})`,
      );
    return value as T;
  }
  async initialize() {
    const session = await this.request<{
      authenticated: boolean;
      csrf_token: string;
    }>("session");
    if (!session.authenticated) throw Error("Sign in to the local service.");
    this.csrf = session.csrf_token;
  }
  async login(token: string) {
    await this.request("session", "POST", { token });
    await this.initialize();
  }
  async logout() {
    let note: string | undefined;
    try {
      await this.releaseClient();
    } catch (error) {
      note = `Signed out; STOP remains unconfirmed: ${String(error)}. Service connection retained.`;
      this.fail(note);
    }
    try {
      await this.request("session", "DELETE");
    } catch (error) {
      if (!(error instanceof RemoteRequestError && error.status === 401))
        note = note ?? `Sign-out request unconfirmed: ${String(error)}`;
    } finally {
      this.dispose();
      this.csrf = "";
    }
    return note;
  }
  async authorizedDroids() {
    const result = await this.request<{
      items: Array<{
        droid_id: string;
        name: string;
      }>;
    }>("droids");
    return result.items.map((d) => ({ id: d.droid_id, name: d.name }));
  }
  async selectDroid(id: string) {
    const generation = (this.selectionGeneration = (this.selectionGeneration ?? 0) + 1);
    this.selectionPending = generation;
    if (this.droid) this.cancelLocalSources();
    try {
      await this.loadDroid(id, generation);
    } finally {
      if (this.selectionPending === generation) this.selectionPending = undefined;
    }
  }
  private async loadDroid(id: string, generation: number) {
    this.refreshGeneration = (this.refreshGeneration ?? 0) + 1;
    this.sharedRefreshGeneration = (this.sharedRefreshGeneration ?? 0) + 1;
    this.stopHeartbeat();
    if (!this.selectionStop && this.droid && this.droid !== id) {
      this.selectionStop = this.releaseClient().catch((error) => {
        // Every selection waits for this STOP, including a return to the same droid.
        this.fail(`Droid switch STOP failed: ${String(error)}. Connection retained.`);
        throw error;
      });
    }
    const stop = this.selectionStop;
    if (stop) {
      try {
        await stop;
      } finally {
        if (this.selectionStop === stop) this.selectionStop = undefined;
      }
    }
    if (this.droid) await this.motion.release();
    if (generation !== this.selectionGeneration) throw Error("Droid selection superseded.");
    const path = `droids/${encodeURIComponent(id)}/`;
    let bundle;
    try {
      bundle = await Promise.all([
        this.request<Preferences>(`${path}preferences`),
        this.request<{
          session: SessionSnapshot;
          name: string;
          droid_id: string;
        }>(path.slice(0, -1)),
        Promise.all(
          ["sounds", "animations", "protocols"].map(async (kind) => {
            const catalog = await this.request<{
              items: CatalogItem[];
            }>(`${path}catalogs/${kind}`);
            return [kind, catalog.items] as const;
          }),
        ),
      ]);
    } catch (error) {
      if (generation === this.selectionGeneration && this.droid) {
        this.handleWindowBlur(true);
        this.fail(`Droid selection failed: ${String(error)}. Connection retained.`);
      }
      throw error;
    }
    const [preferences, snapshot, catalogs] = bundle;
    if (generation !== this.selectionGeneration) throw Error("Droid selection superseded.");
    this.droid = id;
    this.preferences = preferences;
    this.preferenceWriteRevision = preferences.revision;
    this.catalogs = new Map(catalogs);
    this.accept(snapshot);
    if (this.running) this.startHeartbeat();
  }
  private path(suffix = "") {
    if (!this.droid) throw Error("Select an enrolled droid first.");
    return `droids/${encodeURIComponent(this.droid)}${suffix}`;
  }
  private publish(snapshot: SessionSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  private accept(value: { session: SessionSnapshot; name: string; droid_id: string; capabilities?: {motion?: boolean; driveStopUnconfirmed?: boolean; telemetry?: boolean; lightFrames?: boolean}; motion?: {client_id?: string; transitioning?: boolean} }) {
    this.motionSupported = value.capabilities?.motion === true;
    const motionAvailable = this.motionSupported && value.capabilities?.driveStopUnconfirmed !== true;
    if (this.motionAvailable && !motionAvailable) this.cancelLocalSources();
    this.motionAvailable = motionAvailable;
    this.telemetryAvailable = value.capabilities?.telemetry === true;
    this.lightFramesAvailable = value.capabilities?.lightFrames === true;
    const session = value.session;
    // Native STOP temporarily blocks admission without losing the BLE session.
    // Only our open/release or resulting lease may retain the ready cockpit through it.
    const ownTransition = value.motion?.client_id === this.clientId && value.motion.transitioning === true &&
      this.motion.active && this.snapshot.state === "ready" && session.state === "connecting" &&
      session.connection.state !== "disconnected" && session.connection.epoch === this.snapshot.connection.epoch &&
      !this.focusPaused && !this.stopFailure;
    const observedState = ownTransition ? "ready" : session.state;
    const state = this.stopFailure && !session.stopFailure
      ? "failed"
      : this.focusPaused && observedState === "ready"
        ? "paused"
        : observedState;
    if (
      session.connection.epoch !== this.snapshot.connection.epoch ||
      (this.snapshot.state === "ready" && state !== "ready")
    ) this.cancelLocalSources();
    this.publish({
      ...session,
      preferencesRevision: this.preferences.revision,
      state,
      detail: this.stopFailure ?? session.detail,
      connection: { ...session.connection, droidName: value.name, droidId: value.droid_id },
      safety: {
        ...session.safety,
        motionArmed: state === "ready" && this.snapshot.safety.motionArmed,
        wheelsValidated: state === "ready" && session.connection.epoch === this.snapshot.connection.epoch && this.snapshot.safety.wheelsValidated,
        canControl: state === "ready" && (ownTransition || session.safety.canControl),
        state: state === "failed" ? "failed" : state === "paused" ? "paused" : session.safety.state,
      },
    });
  }
  private scheduleRefresh(
    kind: RefreshKind,
    load: (current: () => boolean, droid: string) => Promise<void>,
  ): Promise<void> {
    const droid = this.droid;
    if (!droid) return Promise.resolve();
    const selection = this.selectionGeneration;
    const epoch = () =>
      kind === "snapshot" ? this.refreshGeneration : this.sharedRefreshGeneration;
    const generation = epoch();
    const current = () =>
      selection === this.selectionGeneration && droid === this.droid && generation === epoch();
    this.refreshes ??= new Map();
    let slot = this.refreshes.get(kind);
    if (!slot) {
      slot = {};
      this.refreshes.set(kind, slot);
    }
    if (slot.active?.current()) {
      if (slot.queued?.current()) return slot.queued.promise;
      // Each batch resolves independently, even when notifications never stop.
      const queued: RefreshWork = {
        current,
        promise: slot.active.promise
          .catch(() => {})
          .then(() => {
            if (slot.queued === queued) slot.queued = undefined;
            if (current()) return this.scheduleRefresh(kind, load);
          }),
      };
      slot.queued = queued;
      return queued.promise;
    }
    const active: RefreshWork = {
      current,
      promise: Promise.resolve()
        .then(() => load(current, droid))
        .catch((error) => {
          if (current()) throw error;
        })
        .finally(() => {
          if (slot.active === active) slot.active = undefined;
        }),
    };
    slot.active = active;
    return active.promise;
  }
  refresh() {
    return this.scheduleRefresh("snapshot", async (current, droid) => {
      const value = await this.request<{
        session: SessionSnapshot;
        name: string;
        droid_id: string;
      }>(`droids/${encodeURIComponent(droid)}`);
      if (current()) this.accept(value);
    });
  }
  refreshSharedState() {
    return this.scheduleRefresh("shared", async (current, droid) => {
      const path = `droids/${encodeURIComponent(droid)}/`;
      const [preferences, catalogs] = await Promise.all([
        this.request<Preferences>(`${path}preferences`),
        Promise.all(
          ["sounds", "animations", "protocols"].map(async (kind) => {
            const result = await this.request<{ items: CatalogItem[] }>(`${path}catalogs/${kind}`);
            return [kind, result.items] as const;
          }),
        ),
      ]);
      if (!current()) return;
      // Reads that started before a confirmed save cannot restore its older values.
      if (preferences.revision < this.preferences.revision) return;
      this.preferences = preferences;
      this.catalogs = new Map(catalogs);
      this.publish({ ...this.snapshot, preferencesRevision: preferences.revision });
      await this.refresh();
    });
  }
  start() {
    this.running = true;
    const changed = () => {
      void this.refresh().catch((error) => {
        this.handleWindowBlur(true);
        this.fail(`Service refresh failed: ${String(error)}`);
      });
    };
    const sharedChanged = () => {
      void this.refreshSharedState().catch((error) => {
        this.handleWindowBlur(true);
        this.fail(`Shared settings refresh failed: ${String(error)}`);
      });
    };
    if (this.subscribeChanges && !this.unsubscribeChanges)
      this.unsubscribeChanges = this.subscribeChanges(sharedChanged);
    if (!this.subscribeChanges && !this.stream && typeof EventSource !== "undefined") {
      this.stream = new EventSource(new URL("events", this.base), { withCredentials: true });
      this.stream.onmessage = sharedChanged;
      for (const type of ["snapshot", "state.changed", "operation.updated"])
        this.stream.addEventListener(type, changed);
      for (const type of ["resync_required", "catalog.changed"])
        this.stream.addEventListener(type, sharedChanged);
      this.stream.onerror = () => {
        this.handleWindowBlur(true);
      };
    }
    this.startHeartbeat();
  }
  private stopHeartbeat() {
    this.heartbeatGeneration = (this.heartbeatGeneration ?? 0) + 1;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
  private startHeartbeat() {
    if (!this.running || this.focusPaused || this.heartbeat || !this.droid) return;
    const generation = (this.heartbeatGeneration = (this.heartbeatGeneration ?? 0) + 1);
    const droid = this.droid;
    const selection = this.selectionGeneration;
    const current = () =>
      this.running &&
      generation === this.heartbeatGeneration &&
      selection === this.selectionGeneration &&
      droid === this.droid;
    const beat = () => {
      if (!current()) return;
      void this.request("ui/heartbeat", "POST", {
        client_id: this.clientId,
        droid_id: droid,
        visible: true,
        ...(this.telemetryAvailable ? {telemetry: this.cockpitObservers > 0 || this.sensorsRequested} : {}),
      }).catch((error) => {
        // Only the active visibility/selection lease may revoke this session.
        if (!current()) return;
        this.handleWindowBlur(true);
        this.fail(String(error));
      });
    };
    beat();
    this.heartbeat = setInterval(beat, 1000);
  }
  dispose() {
    this.cancelLocalSources();
    this.running = false;
    this.selectionGeneration = (this.selectionGeneration ?? 0) + 1;
    this.focusGeneration = (this.focusGeneration ?? 0) + 1;
    this.refreshGeneration = (this.refreshGeneration ?? 0) + 1;
    this.sharedRefreshGeneration = (this.sharedRefreshGeneration ?? 0) + 1;
    this.stopHeartbeat();
    this.stream?.close();
    this.stream = undefined;
    this.unsubscribeChanges?.();
    this.unsubscribeChanges = undefined;
  }
  private fail(detail: string) {
    this.stopFailure = detail;
    this.publish({
      ...this.snapshot,
      state: "failed",
      detail,
      safety: {
        ...this.snapshot.safety,
        state: "failed",
        canControl: false,
        motionArmed: false,
      },
    });
  }
  async releaseClient() {
    this.stopHeartbeat();
    this.cancelLocalSources();
    await this.motion.release();
    if (!this.droid) return;
    const result = await this.request<{
      stop?: {
        state?: string;
        error?: string;
      };
      state?: string;
    }>("ui/release", "POST", { client_id: this.clientId, droid_id: this.droid });
    if (result.state === "failed" || result.stop?.state === "failed")
      throw Error(result.stop?.error ?? "Focus-loss STOP failed; connection retained.");
  }
  handleWindowBlur(_hidden: boolean) {
    this.focusGeneration = (this.focusGeneration ?? 0) + 1;
    this.focusPaused = true;
    this.cancelLocalSources();
    if (this.focusStop) return;
    this.publish({
      ...this.snapshot,
      state: this.snapshot.state === "ready" ? "paused" : this.snapshot.state,
      safety: { ...this.snapshot.safety, canControl: false, motionArmed: false },
    });
    const work = this.releaseClient().catch((error) =>
      this.fail(`Focus-loss STOP failed: ${String(error)}. Connection retained.`),
    );
    this.focusStop = work;
    void work.finally(() => {
      if (this.focusStop === work) this.focusStop = undefined;
    });
  }
  async handleWindowFocus() {
    const generation = (this.focusGeneration = (this.focusGeneration ?? 0) + 1);
    await this.focusStop;
    if (generation !== this.focusGeneration) return;
    this.focusPaused = false;
    await this.refresh();
    if (generation === this.focusGeneration && !this.controlBlocked && this.running)
      this.startHeartbeat();
  }
  suspend() {
    this.handleWindowBlur(true);
  }
  loadPreference(key: string) {
    return this.preferences.values[key] ?? null;
  }
  savePreference(key: string, value: string): Promise<void> {
    const droid = this.droid,
      selection = this.selectionGeneration;
    const conflictGeneration = this.preferenceConflictGeneration ?? 0;
    const work = this.saveQueue
      .catch(() => {})
      .then(async () => {
        if (this.droid !== droid || selection !== this.selectionGeneration)
          throw Error("Droid selection changed; save canceled.");
        if (conflictGeneration !== (this.preferenceConflictGeneration ?? 0))
          throw Error("Shared settings changed; review your draft and use a fresh save action.");
        try {
          // Invalidation updates readable values, but does not authorize an open draft
          // to overwrite another client's revision. A conflict still requires review.
          const saved = await this.request<Preferences>(this.path("/preferences"), "PUT", {
            revision: this.preferenceWriteRevision ?? this.preferences.revision,
            values: { ...this.preferences.values, [key]: value },
          });
          if (this.droid !== droid || selection !== this.selectionGeneration)
            throw Error("Droid selection changed after save; refresh the selected droid.");
          if (saved.revision >= this.preferences.revision) this.preferences = saved;
          this.preferenceWriteRevision = saved.revision;
          this.publish({ ...this.snapshot, preferencesRevision: this.preferences.revision });
        } catch (error) {
          if (
            error instanceof RemoteRequestError &&
            error.status === 409 &&
            this.droid === droid &&
            selection === this.selectionGeneration
          ) {
            this.preferenceConflictGeneration = (this.preferenceConflictGeneration ?? 0) + 1;
            const latest = await this.request<Preferences>(this.path("/preferences"));
            if (this.droid === droid && selection === this.selectionGeneration) {
              if (latest.revision >= this.preferences.revision) this.preferences = latest;
              this.preferenceWriteRevision = latest.revision;
              this.publish({ ...this.snapshot, preferencesRevision: this.preferences.revision });
            }
            throw Error(
              `${error.message}. Shared settings changed; review the saved values or your draft before saving again.`,
            );
          }
          throw error;
        }
      });
    this.saveQueue = work;
    return work;
  }
  subscribe(listener: (snapshot: AppSnapshot) => void) {
    listener(this.snapshot);
    return this.store.subscribe(() => listener(this.snapshot));
  }
  subscribeEvents: ControllerSession["subscribeEvents"] = (listener) =>
    this.telemetry.subscribe(listener);
  async operation(action: string, parameters: Record<string, unknown> = {}) {
    if (action === "activity.stop" || action === "connection.disconnect")
      this.cancelLocalSources();
    else if (this.selectionPending !== undefined)
      throw Error("Droid selection is in progress; wait before starting an activity.");
    if (
      (this.focusPaused || this.controlBlocked && action !== 'connection.connect') &&
      action !== "activity.stop" &&
      action !== "connection.disconnect"
    )
      throw Error("Controls are paused.");
    if (this.motion.active) {
      const stopping = action === "activity.stop" || action === "connection.disconnect";
      if (!stopping) this.cancelLocalSources();
      const generation = this.activityGeneration;
      if (stopping) await this.motion.release().catch(() => {});
      else await this.releaseForAction();
      if (!stopping && (generation !== this.activityGeneration || this.focusPaused || this.controlBlocked || this.selectionPending !== undefined))
        throw Error("Operation canceled by STOP or session change.");
    }
    let result = await this.request<Operation>(
      this.path("/operations"),
      "POST",
      {
        action,
        parameters,
        client_id: this.clientId,
        ...(!action.startsWith("connection.") && action !== "activity.stop"
          ? { policy: { if_busy: "replace", if_unavailable: "error" } }
          : {}),
      },
      { "Idempotency-Key": requestId() },
    );
    // The vetted LED schedule can run for 65 seconds. This is only the UI's
    // terminal-status wait; admission deadlines and STOP watchdogs are unchanged.
    const deadline = Date.now() + (action === "protocol.run" ? 90000 : 30000);
    while (["accepted", "running", "queued"].includes(result.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      result = await this.request(`operations/${encodeURIComponent(result.operation_id)}`);
    }
    await this.refresh();
    if (!["dispatched", "completed"].includes(result.state))
      throw Error(
        typeof result.reason === "string"
          ? result.reason
          : (result.reason?.message ??
              result.error?.message ??
              `Operation ${result.state}; it was not replayed.`),
      );
    return result;
  }
  async connect(_services: string[]) {
    if (!this.droid) {
      const droids = await this.authorizedDroids();
      if (droids.length !== 1) throw Error("Choose an enrolled droid from Saved droids.");
      await this.selectDroid(droids[0].id);
    }
    await this.operation("connection.connect");
    this.stopFailure = undefined;
    await this.refresh();
  }
  async reconnectDroid(id: string, services: string[]) {
    await this.selectDroid(id);
    await this.connect(services);
  }
  async disconnect() {
    await this.operation("connection.disconnect");
    this.stopFailure = undefined;
    await this.refresh();
  }
  async sleep() {
    await this.disconnect();
  }
  private stopWork?: Promise<void>;
  stop(): Promise<void> {
    if (this.stopWork) return this.stopWork;
    const work = this.performStop();
    this.stopWork = work;
    const clear = () => { if (this.stopWork === work) this.stopWork = undefined; };
    void work.then(clear, clear);
    return work;
  }
  private async performStop() {
    await this.operation("activity.stop");
    this.stopFailure = undefined;
    await this.refresh();
  }
  async replaceSources() {
    await this.stop();
  }
  async release() {
    this.drivePoint = undefined;
    this.manualMotion.revoke();
    this.publish({...this.snapshot, safety: {...this.snapshot.safety, motionArmed: false}});
    await this.motion.release();
  }
  async releaseDrive() { await this.release(); }
  private async releaseForAction() {
    try { await this.motion.release(); }
    catch (error) {
      await this.refresh();
      // Only the current server snapshot may authorize independent controls.
      // A missing response or an older server's general fault stays blocked.
      if (!this.snapshot.stopFailure || this.snapshot.state !== 'ready') throw error;
    }
  }
  armMotion() {
    if (!this.motionSupported) throw unavailable();
    if (this.motion.stopping) throw Error("Wait for motion STOP to finish.");
    if (this.selectionPending !== undefined || this.focusPaused || this.controlBlocked ||
        this.snapshot.state !== "ready" || !this.snapshot.safety.canControl)
      throw Error("Controls are paused or unavailable.");
    this.publish({...this.snapshot, safety: {...this.snapshot.safety, motionArmed: true}});
  }
  drive(x: number, y: number, speed = 25) {
    if (!this.motionAvailable) throw Error('Wheel drive unavailable until STOP is confirmed.');
    this.armMotion();
    if (![x,y].every(Number.isFinite) || Math.abs(x)>1 || Math.abs(y)>1)
      throw Error("Drive demand must be normalized.");
    if (!Number.isFinite(speed) || speed<0 || speed>100) throw Error("Speed must be 0–100.");
    this.driveSpeed = speed;
    this.drivePoint = [x,y];
    this.sendDrive();
  }
  private sendDrive() {
    if (!this.drivePoint || !this.motionAvailable) return;
    const [left,right] = arcade(...this.drivePoint, this.driveSpeed / 100);
    void this.motion.set(this.path("/motion"), "drive", {
      left: Math.round(Math.abs(left)*255), right: Math.round(Math.abs(right)*255),
      flags: (left<0?8:0)|(right<0?16:0),
    }, 60000).catch(error => {
      if (!this.drivePoint) return;
      this.fail(String(error)); this.cancelLocalSources();
    });
  }
  setDriveSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed<0 || speed>100) throw Error("Speed must be 0–100.");
    this.driveSpeed = speed;
    this.sendDrive();
  }
  validateWheels(epoch = this.snapshot.connection.epoch) {
    this.armMotion();
    if (epoch !== this.snapshot.connection.epoch) throw Error("Connection changed.");
    this.publish({...this.snapshot,safety:{...this.snapshot.safety,wheelsValidated:true}});
  }
  async setDome(degrees: number) {
    this.armMotion(); return this.executeManual(commands.head(degrees));
  }
  async setStance(stance: "two" | "three" | "waddle") {
    this.armMotion(); return this.executeManual(commands.legAction({two:2,three:1,waddle:3}[stance]));
  }
  async pulseDrive(_command: Command): Promise<never> {
    throw unavailable();
  }
  async pulseAdvancedDrive(_command: Command): Promise<never> {
    throw unavailable();
  }
  async startSensors() {
    if (!this.telemetryAvailable) throw unavailable();
    this.sensorsRequested = true;
    this.updateTelemetryDemand();
  }
  async stopSensors() {
    if (!this.telemetryAvailable) throw unavailable();
    this.sensorsRequested = false;
    this.updateTelemetryDemand();
  }
  observeCockpitTelemetry() {
    this.cockpitObservers++;
    this.updateTelemetryDemand();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.cockpitObservers--;
      this.updateTelemetryDemand();
    };
  }
  private updateTelemetryDemand() {
    if (!this.telemetryAvailable) return;
    this.stopHeartbeat();
    this.startHeartbeat();
  }
  getServiceState() {
    return "locked" as const;
  }
  isServiceBusy() {
    return false;
  }
  assertManualSource(_command: Command) {
    if (!this.snapshot.safety.canControl || this.focusPaused || this.controlBlocked)
      throw Error("Controls are paused or unavailable.");
  }
  async executeLightFrame(command: Command, current: () => boolean = () => true) {
    if (!current()) throw Error("Light animation canceled.");
    this.assertManualSource(command);
    if (!this.lightFramesAvailable) throw Error("This service does not support repeating light animations.");
    if (this.selectionPending !== undefined) throw Error("Droid selection is in progress.");
    const data = Array.from(command.data);
    if (command.did !== 26 || command.cid !== 14 || data.length !== 8 || data[0] !== 0 || data[1] !== 0x77)
      throw Error("Expected a dome-only RGB frame.");
    const generation = this.activityGeneration;
    if (this.motion.active) await this.motion.release();
    if (generation !== this.activityGeneration || !current()) throw Error("Light animation canceled.");
    this.assertManualSource(command);
    if (!this.lightFrameToken) {
      const opened = await this.request<{token: string}>(this.path("/lights/open"), "POST", {client_id: this.clientId});
      if (generation !== this.activityGeneration || !current()) throw Error("Light animation canceled.");
      this.assertManualSource(command);
      this.lightFrameToken = opened.token;
    }
    return this.request(this.path("/lights/frame"), "POST", {client_id: this.clientId, token: this.lightFrameToken, rgb: data.slice(2)});
  }
  async executeManual(command: Command, access?: CommandAccess) {
    this.assertManualSource(command);
    return this.execute(command, access);
  }
  async execute(command: Command, _access?: CommandAccess) {
    let action: string, parameters: Record<string, unknown>;
    let motionAction: "drive" | "dome" | "stance" | "animation" | undefined;
    let duration = 60000;
    const data = Array.from(command.data);
    if (command.did === 22 && command.cid === 8 && data.length === 3 && [0,8,16,24].includes(data[2])) {
      motionAction = "drive"; action = "drive";
      parameters = {left:data[0],right:data[1],flags:data[2]};
    } else if (command.did === 23 && command.cid === 15 && data.length === 4) {
      const degrees = new DataView(Uint8Array.from(data).buffer).getFloat32(0,false);
      commands.head(degrees);
      motionAction = "dome"; action = "dome"; duration = 5000; parameters = {degrees};
    } else if (command.did === 23 && command.cid === 13 && data.length === 1 && [1,2,3].includes(data[0])) {
      motionAction = "stance"; action = "stance"; duration = 10000;
      parameters = {stance:({1:"three",2:"two",3:"waddle"} as Record<number,string>)[data[0]]};
    } else if (command.did === 26 && command.cid === 7 && data.length === 3 && data[2] === 0) {
      const sound = sounds.find((s) => s.sector === data[0] * 256 + data[1]);
      if (!sound) throw unavailable();
      action = "sound.play";
      parameters = { sound_id: `sound:${sound.id}` };
    } else if (command.did === 26 && command.cid === 14 && data.length >= 3) {
      const mask = data[0] * 256 + data[1];
      if (mask < 1 || mask > 255) throw unavailable();
      const names = [
        "front_dome_red",
        "front_dome_green",
        "front_dome_blue",
        "readouts",
        "rear_dome_red",
        "rear_dome_green",
        "rear_dome_blue",
        "projector",
      ];
      const selected = names.filter((_, bit) => mask & (1 << bit));
      if (selected.length !== data.length - 2) throw unavailable();
      action = "lights.apply";
      parameters = {
        settings: Object.fromEntries(selected.map((name, index) => [name, data[index + 2]])),
      };
    } else if (
      (command.did === 26 && command.cid === 10) ||
      (command.did === 23 && command.cid === 43)
    ) {
      action = "activity.stop";
      parameters = {};
    } else if (command.did === 23 && command.cid === 5 && data.length === 2) {
      const item = this.catalogs
        .get("animations")
        ?.find(
          (i) =>
            i.firmware_id === data[0] * 256 + data[1] &&
            i.available &&
            (this.motionSupported || !i.effects.includes("motion")),
        );
      if (!item) throw unavailable();
      action = "animation.play";
      parameters = { animation_id: item.id };
      if (item.effects.includes("motion")) motionAction = "animation";
    } else throw unavailable();
    const metadata = {
      type: "command" as const,
      did: command.did,
      cid: command.cid,
      data,
    };
    this.telemetry.emit({ ...metadata, phase: "requested" });
    try {
      let result;
      if (motionAction) {
        if (motionAction === 'drive' && !this.motionAvailable) throw Error('Wheel drive unavailable until STOP is confirmed.');
        if (motionAction !== 'drive' && this.snapshot.stopFailure && this.motion.active && this.motion.action !== motionAction) {
          const generation = this.activityGeneration;
          await this.releaseForAction();
          if (generation !== this.activityGeneration || this.focusPaused) throw Error('Action canceled.');
        }
        this.armMotion();
        result = await this.motion.set(this.path("/motion"), motionAction, parameters, duration);
      } else result = await this.operation(action, parameters);
      this.telemetry.emit({ ...metadata, phase: "acknowledged" });
      return result;
    } catch (error) {
      this.telemetry.emit({ ...metadata, phase: "failed", error: String(error) });
      throw error;
    }
  }
  async runDeviceLightRecipe(input: import("../core/ramRecipe.ts").NordicInlineLedRecipe) {
    if (this.selectionPending !== undefined)
      throw Error("Droid selection is in progress; wait before starting an activity.");
    const item = this.catalogs
      .get("protocols")
      ?.find(
        (i) => i.id === "protocol-device-lights" && i.available && !i.effects.includes("motion"),
      );
    if (!item) throw unavailable();
    const generation = this.activityGeneration ?? 0;
    const serialized = JSON.stringify(input);
    const recipe = JSON.parse(serialized);
    await this.savePreference("device.light-recipe.v1", serialized);
    // Saving can outlive STOP or focus loss; returning focus cannot revive that start.
    if (generation !== (this.activityGeneration ?? 0))
      throw Error("Protocol start canceled by STOP or session change.");
    await this.operation("protocol.run", { protocol_id: item.id, recipe });
  }
  async stopDeviceLightRecipe() {
    await this.stop();
  }
  registerCancel(cancel: () => void) {
    this.cancels.add(cancel);
    return () => {
      this.cancels.delete(cancel);
    };
  }
  cancelLocalSources() {
    this.lightFrameToken = undefined;
    this.activityGeneration = (this.activityGeneration ?? 0) + 1;
    this.drivePoint = undefined;
    this.manualMotion.revoke();
    if (this.snapshot.safety.motionArmed) this.publish({...this.snapshot, safety:{...this.snapshot.safety,motionArmed:false}});
    try { for (const cancel of this.cancels) cancel(); }
    finally { void this.motion.release().catch(() => {}); }
  }
  async requestLocalStart(_source: LocalSource): Promise<never> {
    throw unavailable();
  }
  confirmSourceStart() {}
  cancelSourceStart() {
    this.cancelLocalSources();
  }
  reportSource(_source: LocalSource, _label: string) {}
}
