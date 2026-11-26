import type { ControllerSession } from "../session/ControllerSession.ts";
/** Choosing another task authorizes stopping the previous one, never replaying it. */
export async function prepareTaskSwitch(session: ControllerSession) {
  session.cancelLocalSources();
  const current = session.store.getSnapshot();
  if (current.state === "failed" || current.stopFailure) return;
  // Service exit has its own acknowledged stop/exit barrier in Navigator.
  if (session.getServiceState() !== "locked" || session.isServiceBusy()) return;
  // Also clear conservative unknown ownership after a prior STOP or connection.
  // A response-free emergency stop alone cannot establish that resources are free.
  if (current.state === "ready") await session.replaceSources();
}
