class MotionStopError extends Error {}

type Action = 'drive' | 'dome' | 'stance' | 'animation';
type Demand = { action: Action; parameters: Record<string, unknown>; revision: number };
type Lease = { path: string; lease_id: string; token?: string };
type Transport = <T>(path: string, method: string, body: unknown) => Promise<T>;

/** One in-flight exchange and one latest demand. Tokens never survive release. */
export class RemoteMotion {
  private request: Transport;
  private clientId: string;
  private failed: (error: unknown) => void;
  private expired: () => void;
  private generation = 0;
  private revision = 0;
  private sentRevision = 0;
  private demand?: Demand;
  private lease?: Lease;
  private work?: Promise<unknown>;
  private releasing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private waiters = new Set<() => void>();
  private deadline = 0;
  private cap = 0;
  private renewalDue = false;
  private nextExchangeAt = 0;
  constructor(request: Transport, clientId: string, failed: (error: unknown) => void, expired: () => void) {
    this.request = request; this.clientId = clientId; this.failed = failed; this.expired = expired;
  }
  get stopping() { return !!this.releasing; }
  get action() { return this.demand?.action; }
  get active() { return !!(this.demand || this.lease || this.work || this.releasing); }
  async set(path: string, action: Action, parameters: Record<string, unknown>, duration: number) {
    const generation = this.generation;
    if (this.releasing) throw Error('Wait for motion STOP to finish.');
    if (this.demand && this.demand.action !== action) {
      await this.release();
      // release increments once; any additional cancellation invalidates this start.
      if (this.generation !== generation + 1) throw Error('Motion start canceled.');
    }
    const current = this.generation;
    const revision = ++this.revision;
    this.demand = {action, parameters, revision};
    const starting = !this.timer;
    if (starting) {
      this.cap = Date.now() + 60000;
      this.timer = setInterval(() => {
        if (Date.now() >= this.deadline) {
          // Revoke the UI owner and its cached demand before requesting STOP.
          try { this.expired(); }
          finally { void this.release().catch(() => {}); }
          return;
        }
        if (this.work) { this.renewalDue = true; return; }
        if (Date.now() < this.nextExchangeAt) return;
        void this.tick(path, current).catch(error => {
          if (current !== this.generation) return;
          this.expired();
          void this.release().catch(() => {});
        });
      }, 100);
    }
    this.deadline = Math.min(this.cap, Date.now() + duration);
    if (starting) void this.tick(path, current).catch(() => {});
    while (this.sentRevision < revision) {
      if (current !== this.generation) throw Error('Motion start canceled.');
      try {
        if (this.work) await this.work;
        else await new Promise<void>(resolve => this.waiters.add(resolve));
      }
      catch (error) {
        if (current === this.generation) {
          this.expired();
          await this.release().catch(() => {});
        }
        throw error;
      }
    }
    if (current !== this.generation) throw Error('Motion start canceled.');
    return {state: 'dispatched', confirmation: 'ack'};
  }
  private tick(path: string, generation: number): Promise<unknown> {
    if (this.work) return this.work;
    if (generation !== this.generation || !this.demand) return Promise.resolve();
    this.renewalDue = false;
    this.nextExchangeAt = Date.now() + 100;
    let succeeded = false;
    const work = this.exchange(path, generation).then(value => { succeeded = true; return value; });
    this.work = work;
    void work.finally(() => {
      if (this.work === work) this.work = undefined;
      this.wakeWaiters();
      // A slow reply must not add another interval of idle time to the next
      // freshness exchange. Keep one write in flight and the 10 Hz start cap.
      if (succeeded && this.renewalDue && generation === this.generation && this.demand &&
          Date.now() >= this.nextExchangeAt && Date.now() < this.deadline)
        void this.tick(path, generation).catch(() => {
          if (generation !== this.generation) return;
          this.expired(); void this.release().catch(() => {});
        });
    }).catch(() => {});
    return work;
  }
  private async exchange(path: string, generation: number) {
    let token: string;
    let lease = this.lease;
    if (!lease) {
      const opened = await this.request<{lease_id: string; token: string}>(`${path}/open`, 'POST', {client_id: this.clientId});
      lease = {path, ...opened};
      if (generation !== this.generation) {
        await this.stopLease(lease);
        return;
      }
      this.lease = lease;
      token = opened.token;
    } else if (lease.token) {
      token = lease.token;
    } else {
      const challenge = await this.request<{token: string}>(`${lease.path}/challenge`, 'POST', {client_id: this.clientId, lease_id: lease.lease_id});
      token = challenge.token;
    }
    lease.token = undefined;
    // Re-read the latest target after admission; never drain a backlog.
    if (generation !== this.generation || !this.demand) return;
    const demand = this.demand;
    const fresh = demand.revision > this.sentRevision;
    const action = fresh || demand.action === 'drive' ? demand.action : 'renew';
    const result = await this.request<{state: string; confirmation?: string; token?: string}>(`${lease.path}/command`, 'POST', {
      client_id: this.clientId, lease_id: lease.lease_id, token, action,
      parameters: action === 'renew' ? {} : demand.parameters,
    });
    if (generation !== this.generation) return;
    if (result.state !== 'dispatched' || (result.confirmation !== 'ack' && !(action === 'renew' && result.confirmation === 'none')))
      throw Error('Motion acknowledgment missing; STOP required.');
    // Acknowledgments may carry the next one-use challenge. Older services use /challenge.
    if (typeof result.token === 'string' && result.token) lease.token = result.token;
    this.sentRevision = demand.revision;
  }
  private wakeWaiters() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
  private async stopLease(lease: Lease) {
    try {
      const result = await this.request<{state?: string; stop?: {state?: string; error?: string}}>(`${lease.path}/release`, 'POST', {client_id: this.clientId, lease_id: lease.lease_id});
      if (!result || !['completed', 'stopped'].includes(result.state ?? '') || result.stop?.state === 'failed')
        throw Error(result?.stop?.error ?? 'Motion STOP failed or completion was not confirmed.');
    } catch (error) { this.failed(error); throw new MotionStopError(String(error), {cause: error}); }
  }
  release(): Promise<void> {
    // Revoke synchronously, before waiting for any open/challenge/STOP response.
    ++this.generation;
    this.renewalDue = false;
    clearInterval(this.timer); this.timer = undefined; this.demand = undefined;
    this.wakeWaiters();
    if (this.releasing) return this.releasing;
    const lease = this.lease; this.lease = undefined;
    const pending = this.work;
    const release = (async () => {
      const results = await Promise.allSettled([
        lease ? this.stopLease(lease) : Promise.resolve(),
        // A late open owns its own STOP; command errors cannot suppress that STOP.
        pending?.catch(error => { if (error instanceof MotionStopError) throw error; }),
      ]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    this.releasing = release;
    void release.finally(() => { if (this.releasing === release) this.releasing = undefined; }).catch(() => {});
    return release;
  }
}
