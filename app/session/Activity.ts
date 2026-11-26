import type { Command } from "../../core/index.ts";
import { ResourceConflictError } from "../../core/index.ts";
import type { ActivitySnapshot, LocalSource } from "./types.ts";
/** Local ownership is synchronous so focus/STOP cancels routines before React renders. */
export class SessionActivity {
  snapshot: ActivitySnapshot = {
    source: null,
    label: "",
    sources: { automation: "", experience: "" },
  };
  private callbacks = new Set<() => void>();
  private cancelling = false;
  private intent = 0;
  get generation() {
    return this.intent;
  }
  private pending?: { resolve: () => void; reject: (error: Error) => void };
  private changed: () => void;
  constructor(changed: () => void) {
    this.changed = changed;
  }
  registerCancel(cancel: () => void) {
    this.callbacks.add(cancel);
    return () => {
      this.callbacks.delete(cancel);
    };
  }
  report(source: LocalSource, label: string) {
    const sources = { ...this.snapshot.sources, [source]: label };
    const active = sources.experience
      ? "experience"
      : sources.automation
        ? "automation"
        : null;
    this.snapshot = {
      ...this.snapshot,
      source: active,
      label: active ? sources[active] : "",
      sources,
    };
    this.changed();
  }
  manual(label: string) {
    this.snapshot = {
      ...this.snapshot,
      source: label ? "manual" : null,
      label,
    };
    this.changed();
  }
  cancelStart() {
    this.intent++;
    this.pending?.reject(new Error("Source replacement canceled."));
    this.pending = undefined;
    this.snapshot = { ...this.snapshot, pendingStart: undefined };
    this.changed();
  }
  confirmStart() {
    const pending = this.pending;
    this.pending = undefined;
    this.snapshot = { ...this.snapshot, pendingStart: undefined };
    this.changed();
    pending?.resolve();
  }
  async request(source: LocalSource) {
    this.cancel();
    this.report(
      source,
      source === "automation"
        ? "Starting local protocol / patrol"
        : "Starting local experience",
    );
  }
  cancel() {
    if (this.cancelling) return;
    this.cancelling = true;
    try {
      this.cancelStart();
      for (const cancel of [...this.callbacks]) {
        try {
          cancel();
        } catch {
          /* One owner cannot prevent the other owners from being revoked. */
        }
      }
      this.snapshot = {
        source: null,
        label: "",
        sources: { automation: "", experience: "" },
      };
      this.changed();
    } finally {
      this.cancelling = false;
    }
  }
  assertManual(command: Command) {
    const owners = Object.values(this.snapshot.sources).filter(Boolean);
    const observing =
      (command.did === 0x13 && [3, 4].includes(command.cid)) ||
      (command.did === 0x17 && [20, 22, 37].includes(command.cid)) ||
      (command.did === 0x1a && command.cid === 9) ||
      command.did === 0x11 ||
      (command.did === 0x18 && [1, 13].includes(command.cid));
    if (owners.length && !observing)
      throw new ResourceConflictError(owners, "manual control");
  }
}
