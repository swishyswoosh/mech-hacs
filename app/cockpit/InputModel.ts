export type PadSample = {
  at: number;
  deviceId: string;
  axes: number[];
  buttons: boolean[];
};
const defaultButtons: Record<string, number> = {
  slot1: 0,
  slot2: 1,
  slot3: 2,
  slot4: 3,
  slot5: 12,
  slot6: 15,
  slot7: 13,
  slot8: 14,
  slot9: -1,
  gearDown: 4,
  gearUp: 5,
  stance: 10,
  stop: 9,
  home: 8,
};
export class CockpitInput {
  private keys: Record<string, string>;
  private buttons: Record<string, number>;
  private held = new Set<string>();
  private previous?: PadSample;
  private neutral = false;
  private bAt?: number;
  private bStopped = false;
  constructor(
    keys: Record<string, string>,
    buttons: Record<string, number> = defaultButtons,
  ) {
    this.keys = keys;
    this.buttons = buttons;
  }
  revoke() {
    this.held.clear();
    this.previous = undefined;
    this.neutral = false;
    this.bAt = undefined;
    this.bStopped = false;
  }
  key(code: string, down: boolean, repeat: boolean) {
    const action = this.actionFor(code);
    if (!action || (down && repeat))
      return { handled: false, point: this.point() };
    if (down) this.held.add(code);
    else this.held.delete(code);
    return {
      handled: true,
      point: this.point(),
      action: down && !action.startsWith("drive") ? action : undefined,
      dome: this.dome(),
    };
  }
  private actionFor(code: string) {
    if (code === "Escape") return "stop";
    return (
      Object.keys(this.keys).find((key) => this.keys[key] === code) ||
      (
        {
          ArrowUp: "driveUp",
          ArrowDown: "driveDown",
          ArrowLeft: "driveLeft",
          ArrowRight: "driveRight",
        } as Record<string, string>
      )[code]
    );
  }
  private has(action: string) {
    return [...this.held].some((code) => this.actionFor(code) === action);
  }
  point(): [number, number] {
    return [
      Number(this.has("driveRight")) - Number(this.has("driveLeft")),
      Number(this.has("driveUp")) - Number(this.has("driveDown")),
    ];
  }
  dome() {
    return Number(this.has("domeRight")) - Number(this.has("domeLeft"));
  }
  gamepad(sample: PadSample, now: number) {
    const fail = (message: string): never => {
      this.revoke();
      throw Error(message);
    };
    if (
      !Number.isFinite(sample.at) ||
      sample.at <= 0 ||
      sample.at > now ||
      now - sample.at > 300
    )
      fail("Gamepad hardware timestamp stale or invalid; activate again.");
    if (
      !sample.deviceId ||
      sample.axes.length < 4 ||
      !sample.axes.every(Number.isFinite) ||
      !sample.buttons.every((v) => typeof v === "boolean")
    )
      fail("Invalid gamepad report");
    const previous = this.previous;
    if (previous) {
      if (sample.deviceId !== previous.deviceId)
        fail("Gamepad changed; activate again.");
      if (sample.at < previous.at) fail("Gamepad timestamp regressed");
      if (
        sample.at === previous.at &&
        JSON.stringify([sample.axes, sample.buttons]) !==
          JSON.stringify([previous.axes, previous.buttons])
      )
        fail("Gamepad changed without a fresh timestamp");
    }
    this.previous = {
      ...sample,
      axes: [...sample.axes],
      buttons: [...sample.buttons],
    };
    if (!this.neutral) {
      this.neutral =
        sample.axes.every((v) => Math.abs(v) <= 0.08) &&
        sample.buttons.every((v) => !v);
      return {
        ready: this.neutral,
        point: [0, 0] as [number, number],
        dome: 0,
        actions: [] as string[],
      };
    }
    const actions: string[] = [];
    const stopIndex = this.buttons.stop ?? 9;
    if (
      (sample.buttons[9] && !previous?.buttons[9]) ||
      (stopIndex >= 0 &&
        sample.buttons[stopIndex] &&
        !previous?.buttons[stopIndex])
    )
      return {
        ready: true,
        point: [0, 0] as [number, number],
        dome: 0,
        actions: ["stop"],
      };
    const b = this.buttons.slot2 ?? 1;
    for (const [action, index] of Object.entries(this.buttons)) {
      if (
        index < 0 ||
        index === b ||
        index === 9 ||
        action === "stop" ||
        action.startsWith("drive") ||
        ["domeLeft", "domeRight"].includes(action)
      )
        continue;
      if (sample.buttons[index] && !previous?.buttons[index])
        actions.push(action);
    }
    if (b >= 0 && b !== 9 && b !== stopIndex) {
      if (sample.buttons[b]) {
        if (!previous?.buttons[b]) {
          this.bAt = now;
          this.bStopped = false;
        }
        if (this.bAt !== undefined && now - this.bAt >= 500 && !this.bStopped) {
          actions.push("stop");
          this.bStopped = true;
        }
      } else if (previous?.buttons[b] && this.bAt !== undefined) {
        if (!this.bStopped) actions.push("slot2");
        this.bAt = undefined;
      }
    }
    const held = (action: string) =>
      Number(!!sample.buttons[this.buttons[action]]);
    const clamp = (n: number) => Math.max(-1, Math.min(1, n));
    return {
      ready: true,
      point: [
        clamp(sample.axes[0] + held("driveRight") - held("driveLeft")),
        clamp(-sample.axes[1] + held("driveUp") - held("driveDown")),
      ] as [number, number],
      dome: clamp(sample.axes[2] + held("domeRight") - held("domeLeft")),
      actions,
    };
  }
}

/** A source rejected during release/conflict must return neutral before retrying. */
export class DriveInputLatch {
  private blocked = new Set<string>();
  accept(source: string, point: [number, number], begin: () => boolean) {
    if (!point[0] && !point[1]) {
      this.blocked.delete(source);
      return false;
    }
    if (this.blocked.has(source)) return false;
    if (!begin()) {
      this.blocked.add(source);
      return false;
    }
    return true;
  }
  clear() {
    this.blocked.clear();
  }
}
