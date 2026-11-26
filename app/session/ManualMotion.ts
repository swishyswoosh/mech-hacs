/** One lease across accessible/advanced pulses and continuous manual input.
 * A new generation fences delayed zero/STOP callbacks from an earlier source. */
export type ManualMotionToken = {
  readonly generation: number;
  readonly kind: string;
};
export class ManualMotionLease {
  private generation = 0;
  private owner?: ManualMotionToken;
  get active() {
    return !!this.owner;
  }
  acquire(kind: string): ManualMotionToken {
    if (this.owner)
      throw new Error(
        `Manual motion already active (${this.owner.kind}); release it before starting another input.`,
      );
    return (this.owner = { generation: ++this.generation, kind });
  }
  owns(token: ManualMotionToken) {
    return this.owner === token;
  }
  release(token: ManualMotionToken) {
    if (this.owns(token)) this.owner = undefined;
  }
  revoke() {
    this.owner = undefined;
    ++this.generation;
  }
  guard(
    token: ManualMotionToken,
    action: () => Promise<unknown>,
  ): () => Promise<void> {
    return async () => {
      if (token.generation === this.generation) await action();
    };
  }
}
