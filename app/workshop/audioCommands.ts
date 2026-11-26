import { commands } from "../../core/commands.ts";
function draftInteger(text: string, max: number, label: string) {
  const number = Number(text);
  if (!text.trim() || !Number.isInteger(number) || number < 0 || number > max)
    throw new Error(`${label} must be an integer from 0 to ${max}.`);
  return number;
}
export function volumeDraftCommand(text: string) {
  return commands.volume(draftInteger(text, 255, "Volume"));
}
export function soundSectorDraftCommand(text: string) {
  return commands.audio(draftInteger(text, 65535, "Sound sector"));
}
