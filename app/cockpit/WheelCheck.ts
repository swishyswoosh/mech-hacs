import type { PulseDirection } from "../../core/accessiblePulse.ts";
/** Observations are scoped to a ready connection; failed or stale pulses prove nothing. */
export class WheelCheck {
  readonly epoch: number;
  stage: "prepare" | "forward" | "turn" | "complete" = "prepare";
  xSign = 1;
  ySign = 1;
  busy = false;
  private observed = false;
  private expired = false;
  private generation = 0;
  private validate: () => void;
  private pulse: (direction: PulseDirection) => Promise<void>;
  constructor(
    epoch: number,
    validate: () => void,
    pulse: (direction: PulseDirection) => Promise<void>,
  ) {
    this.epoch = epoch;
    this.validate = validate;
    this.pulse = pulse;
  }
  prepare() {
    if (this.expired) throw Error("Wheel check expired");
    if (this.stage === "prepare") this.stage = "forward";
  }
  async nudge() {
    if (this.expired || this.busy || !["forward", "turn"].includes(this.stage))
      throw Error("Wheel check nudge unavailable");
    this.busy = true;
    this.observed = false;
    const generation = this.generation;
    try {
      await this.pulse(
        this.stage === "forward"
          ? this.ySign === 1
            ? "Forward"
            : "Reverse"
          : this.xSign === 1
            ? "Turn Left"
            : "Turn Right",
      );
      if (generation === this.generation && !this.expired) this.observed = true;
    } finally {
      this.busy = false;
    }
  }
  confirm() {
    if (this.expired || this.busy || !this.observed)
      throw Error("Complete a successful nudge before confirming");
    this.observed = false;
    if (this.stage === "forward") this.stage = "turn";
    else if (this.stage === "turn") {
      this.validate();
      this.stage = "complete";
    }
  }
  swap() {
    if (this.expired || this.busy) throw Error("Wait for the nudge to finish");
    if (this.stage === "forward") this.ySign *= -1;
    else if (this.stage === "turn") this.xSign *= -1;
    this.observed = false;
  }
  cancel() {
    this.generation++;
    this.expired = true;
    this.observed = false;
  }
  get canConfirm() {
    return this.observed && !this.busy && !this.expired;
  }
}
