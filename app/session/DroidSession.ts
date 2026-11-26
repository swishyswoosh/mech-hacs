import {compileNordicInlineLedRecipe} from "../../core/ramRecipe.ts";
import type {NordicInlineLedRecipe} from "../../core/ramRecipe.ts";
import { sounds } from "../../core/catalogs.ts";
import type { Command, CommandAccess } from "../../core/index.ts";
import { commands, commandClaim, DroidResponseError } from "../../core/index.ts";
import { SessionOperations } from "./SessionOperations.ts";
import type { AppPort, ExperienceHandle, LocalSource } from "./types.ts";
export class DroidSession extends SessionOperations implements AppPort {
  get motionAvailable() { return !this.controller?.driveStopUnconfirmed; }
  private focusResume?: Promise<void>;
  armMotion() {
    if (this.focusPaused || this.snapshot.state === "paused")
      throw new Error("Control paused while Chrome is unfocused.");
    if (this.stopping || this.sensorApplying || this.snapshot.state !== "ready")
      throw new Error("Droid is not ready.");
    if (!this.controller) throw new Error("Choose a droid first.");
    this.hooks.assertReady?.();
    this.hooks.beforeArm?.();
    this.controller.armMotion();
    this.hooks.arm?.();
    this.publish({});
  }
  handleWindowBlur(pageHidden: boolean) {
    if (this.chooserOpen && !pageHidden) return;
    // A pending chooser is not a live GATT link. Keep cancellation on true hiding.
    if (this.chooserOpen) {
      this.suspend();
      return;
    }
    this.focusPaused = true;
    if (
      this.focusStop ||
      !this.controller ||
      !["ready", "failed", ...(this.focusResume ? ["paused"] : [])].includes(this.snapshot.state)
    )
      return;
    const controller = this.controller,
      work = this.stop(true);
    this.focusStop = work;
    this.publish({
      state: controller.state === "ready" ? "paused" : "failed",
      detail:
        "Foreground lost; stop requested and controls disarmed. Bluetooth connection retained.",
    });
    void work
      .catch((error) => {
        if (this.controller === controller)
          this.publish({
            state: "failed",
            detail: `Focus-loss STOP failed: ${String(error)}. Bluetooth retained; verify physical stop.`,
          });
      })
      .finally(() => {
        if (this.focusStop === work) this.focusStop = undefined;
      });
  }
  async handleWindowFocus() {
    this.focusPaused = false;
    await this.focusStop?.catch(() => {});
    // Duplicate native/window focus events share one confirmation. A new blur
    // cancels it through STOP's generation fence before another resume can run.
    if (this.focusResume) await this.focusResume;
    const controller = this.controller;
    if (this.focusPaused || !controller || controller.state !== "ready") return;
    if (this.snapshot.state === "failed" && this.snapshot.stopFailure) {
      // Returning foreground restores only fresh, independently gated actions.
      // The wheel-stop fault and the motion latch remain in force.
      this.publish({state: "ready"});
      return;
    }
    if (this.snapshot.state !== "paused") return;
    const intent = this.sensorIntent;
    const current = () => !this.focusPaused && this.controller === controller &&
      this.sensorIntent === intent && this.snapshot.state === "paused";
    const work = (async () => {
      try {
        await this.hooks.beforeResume?.(controller);
        if (current() && controller.state === "ready") this.publish({
          state: "ready",
          detail: "Bluetooth connection retained. Controls remain disarmed; choose a fresh action.",
        });
      } catch (error) {
        if (current()) this.publish({state:"failed",detail:`Resume STOP confirmation failed: ${String(error)}`});
      }
    })();
    this.focusResume = work;
    try { await work; }
    finally { if (this.focusResume === work) this.focusResume = undefined; }
  }
  suspend() {
    this.recordLifecycle("page-suspend","Page hide/unload requested stop and disconnect");
    this.focusPaused = true;
    void this.stop()
      .catch(() => {})
      .finally(() => this.disconnect());
    this.publish({
      detail:
        "Page closing; local control revoked. Stop delivery unconfirmed until checked.",
    });
  }
  async requestLocalStart(source: LocalSource) {
    if (this.snapshot.state !== "ready" || this.stopping || this.focusPaused)
      throw new Error("Droid is not ready");
    const preparing = this.activity.request(source);
    const generation = this.activity.generation;
    await preparing;
    if (generation !== this.activity.generation)
      throw new Error("Source start canceled");
    try {
      await this.replaceSources();
      if (generation !== this.activity.generation || this.snapshot.state !== "ready" || this.stopping || this.focusPaused)
        throw new Error("Source start canceled");
    } catch (error) {
      if (generation === this.activity.generation) this.activity.cancel();
      throw error;
    }
  }

  confirmSourceStart() {
    this.activity.confirmStart();
  }
  cancelSourceStart() {
    this.activity.cancelStart();
  }
  registerExperience(id: string, handle: ExperienceHandle) {
    if (this.experiences.has(id))
      throw new Error("Experience is already registered");
    this.experiences.set(id, handle);
    const detach = this.registerCancel(() => handle.cancel());
    return () => {
      detach();
      if (this.experiences.get(id) === handle) this.experiences.delete(id);
    };
  }
  async startExperience(id: string) {
    const handle = this.experiences.get(id);
    if (!handle) throw new Error("Unknown experience");
    await this.requestLocalStart("experience");
    const generation = this.activity.generation;
    this.reportSource("experience", handle.label);
    try {
      await handle.start();
      if (generation !== this.activity.generation)
        throw new Error("Experience start canceled");
    } catch (error) {
      if (generation === this.activity.generation) {
        handle.cancel();
        this.reportSource("experience", "");
      }
      throw error;
    }
  }
  registerCancel(cancel: () => void) {
    return this.activity.registerCancel(cancel);
  }
  cancelLocalSources() {
    this.driveLoop.revoke();
    this.manualMotion.revoke();
    this.activity.cancel();
  }
  reportSource(source: LocalSource, label: string) {
    this.activity.report(source, label);
  }
  assertManualSource(command: Command) {
    this.activity.assertManual(command);
  }
  async executeManual(command: Command, access?: CommandAccess) {
    this.assertManualSource(command);
    return this.execute(command, { replace: !!commandClaim(command), ...access });
  }
  validateWheels(expectedEpoch = this.connectionEpoch) {
    this.wheelGate.validate(expectedEpoch);
    this.publish({});
  }
  revokeWheels() {
    this.wheelGate.revoke();
    this.driveLoop.revoke();
    this.publish({});
  }
  drive(x: number, y: number, speedPercent = 25) {
    this.activity.assertManual(commands.tank(1, 1));
    if (!this.motionAvailable) throw new Error("Drive stop is unconfirmed. Retry STOP before driving.");
    this.driveLoop.drive(x, y, speedPercent);
    this.activity.manual("Driving");
  }
  setDriveSpeed(speedPercent: number) {
    this.driveLoop.setSpeed(speedPercent);
  }
  async release() {
    const work = this.driveLoop.release();
    const epoch = this.driveLoop.epoch;
    await work;
    if (epoch === this.driveLoop.epoch) this.activity.manual("");
    this.publish({});
  }
  setDome(degrees: number) {
    const command = commands.head(degrees);
    this.assertManualSource(command);
    this.armMotion();
    return this.executeManual(command);
  }
  setStance(stance: "two" | "three" | "waddle") {
    const command = commands.legAction({ two: 2, three: 1, waddle: 3 }[stance]);
    this.assertManualSource(command);
    this.armMotion();
    return this.executeManual(command);
  }
  playSound(id: number) {
    const sound = sounds.find((sound) => sound.id === id);
    if (!sound) throw new Error("Unknown sound");
    return this.executeManual(commands.audio(sound.sector));
  }
  playAnimation(id: number) {
    const command = commands.animation(id);
    this.assertManualSource(command);
    this.armMotion();
    return this.executeManual(command);
  }
  setLights(values: number[]) {
    return this.executeManual(commands.leds(255, values));
  }
  async runDeviceLightRecipe(input:NordicInlineLedRecipe) {
    this.requireReady();
    compileNordicInlineLedRecipe(input);
    const recipe=JSON.parse(JSON.stringify(input)) as NordicInlineLedRecipe;
    const controller=this.controller!,intent=this.sensorIntent;
    await controller.verifyDeviceRamFirmware();this.checkIntent(intent);
    await this.hooks.configureDeviceRamStop?.();this.checkIntent(intent);
    await this.requestLocalStart("automation");
    const generation=this.activity.generation;
    this.reportSource("automation","Droid-RAM light sequence");
    let timer:ReturnType<typeof setTimeout>|undefined,resolveWait!:()=>void,rejectWait!:(e:Error)=>void;
    const wait=new Promise<void>((resolve,reject)=>{resolveWait=resolve;rejectWait=reject;});
    const settled=wait.then(()=>({error:undefined}),error=>({error}));
    const unregister=this.registerCancel(()=>rejectWait(new Error("Device light sequence canceled")));
    try{
      this.checkIntent(intent);
      const duration=await controller.startDeviceLightRecipe(recipe);
      timer=setTimeout(resolveWait,duration+100);
      const result=await settled;if(result.error)throw result.error;
      this.checkIntent(intent);
      if(generation!==this.activity.generation||this.controller!==controller)throw new Error("Device light sequence canceled");
      await controller.cancelDeviceLightRecipe();
    }catch(error){
      if(this.controller===controller&&this.snapshot.state==='ready'&&generation===this.activity.generation){
        try{await controller.cancelDeviceLightRecipe();}catch(stopError){this.publish({state:'failed',detail:`Device-RAM cancellation failed: ${String(stopError)}. Bluetooth retained.`});}
      }
      throw error;
    }finally{
      clearTimeout(timer);unregister();
      if(generation===this.activity.generation)this.reportSource("automation","");
    }
  }
  async stopDeviceLightRecipe(){
    this.requireReady();this.cancelLocalSources();
    await this.controller!.cancelDeviceLightRecipe();
  }
  async readPlayMode() {
    this.requireReady();
    const controller=this.controller!, intent=this.sensorIntent;
    const mode=await controller.readPlayMode();
    this.checkIntent(intent);
    if(this.controller!==controller)throw new Error("Connection changed");
    return mode;
  }
  async sleep() {
    this.requireReady();
    const intent = this.sensorIntent;
    this.cancelLocalSources();
    try {
      await this.replaceSources();
    } catch (error) {
      // Low battery rejects leg hold (17/0d), including the hold in STOP.
      // An explicit power-down still needs to reach the power controller.
      // Preserve the failure; this exception never restores motion readiness.
      if (!(error instanceof DroidResponseError) || error.packet.did !== 0x17 ||
          error.packet.cid !== 0x0d || error.packet.error !== 4) throw error;
      this.recordLifecycle("sleep-stop-leg-rejected", String(error));
    }
    this.checkIntent(intent);
    const controller=this.controller!;
    let confirmed=false, timer:ReturnType<typeof setTimeout>|undefined;
    let resolveSleep!:()=>void, rejectSleep!:(error:Error)=>void;
    const completed=new Promise<void>((resolve,reject)=>{resolveSleep=resolve;rejectSleep=reject;});
    // Install rejection handling before sending: notifications can precede ACK.
    const outcome=completed.then(()=>({error:undefined}),error=>({error}));
    const unsubscribe=this.subscribeEvents(event=>{
      if(event.type==='notification'&&event.notification.type==='did-sleep'){
        confirmed=true;resolveSleep();
      } else if(event.type==='connection'&&event.state==='disconnected'&&!confirmed){
        rejectSleep(new Error('Bluetooth ended before sleep was confirmed'));
      }
    });
    timer=setTimeout(()=>rejectSleep(new Error('Sleep completion not received; connection retained')),15000);
    this.publish({state:"sleep-requested",detail:"Sleep requested; waiting for the droid to finish its sleep sequence."});
    const metadata={type:'command' as const,did:19,cid:1,data:[] as number[]};
    try {
      this.telemetry.emit({...metadata,phase:'requested'});
      try{await controller.command(commands.sleep());this.telemetry.emit({...metadata,phase:'acknowledged'});}
      catch(error){if(!confirmed)throw error;}
      const result=await outcome;if(result.error)throw result.error;
      this.recordLifecycle('sleep-confirmed','Normal sleep completion notification received.');
      // The controller closes only on did-sleep. Never cut off the three-second
      // pre-sleep stance sequence merely because the request was acknowledged.
    } catch(error) {
      this.telemetry.emit({...metadata,phase:'failed',error:String(error)});
      if(this.controller===controller&&controller.state==='ready')this.publish({state:'failed',detail:`Sleep unconfirmed: ${String(error)}. Bluetooth retained.`});
      throw error;
    } finally {clearTimeout(timer);unsubscribe();}
  }
  pulseDrive(command: Command) {
    if (!this.motionAvailable) throw new Error("Drive stop is unconfirmed. Retry STOP before driving.");
    this.requireReady();
    if (!this.hooks.pulse)
      throw new Error("Native fixed-deadline pulses are unavailable");
    this.hooks.assertReady?.();
    this.assertManualSource(command);
    return this.hooks.pulse(command, false);
  }
  pulseAdvancedDrive(command: Command) {
    if (!this.motionAvailable) throw new Error("Drive stop is unconfirmed. Retry STOP before driving.");
    this.requireReady();
    if (!this.hooks.pulse)
      throw new Error("Native fixed-deadline pulses are unavailable");
    this.hooks.assertReady?.();
    this.assertManualSource(command);
    return this.hooks.pulse(command, true);
  }
  acquireSourceLease(id: string, drive = false) {
    if (drive && !this.motionAvailable) throw new Error("Drive stop is unconfirmed. Retry STOP before driving.");
    this.requireReady();
    return this.hooks.acquireSourceLease?.(id, drive) ?? Promise.resolve();
  }
  renewSourceLease(id: string) {
    this.requireReady();
    this.hooks.renewSourceLease?.(id);
  }
  releaseSourceLease(id: string) {
    this.hooks.releaseSourceLease?.(id);
  }
}
