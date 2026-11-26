export function shouldShowComlinkMessage(text: string, failureActive = false): boolean {
  // Suppress only the superseded operation, never a failed STOP that wraps it.
  return Boolean(text) && (failureActive || !/^(?:Error: )?Operation canceled by emergency STOP or disconnect\.$/.test(text));
}
