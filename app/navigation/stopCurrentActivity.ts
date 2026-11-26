import type { ControllerSession } from "../session/ControllerSession.ts";
export async function stopCurrentActivity(session: ControllerSession) {
  session.cancelLocalSources();
  await session.replaceSources();
}
