/** Decode big-endian uint16 centivolts; voltage is not a charge percentage. */
export function batteryReading(response?: string): string {
  const bytes = response?.match(
    /^Battery voltage response: ([0-9a-f]{2}) ([0-9a-f]{2}) \(/i,
  );
  if (!bytes) return "Unavailable";
  return `${((parseInt(bytes[1], 16) * 256 + parseInt(bytes[2], 16)) / 100).toFixed(2)} V`;
}

/** Charge-state labels shared by query replies and notifications. */
export function batteryLevel(data: Uint8Array): string {
  if (data.length !== 1) return "Unavailable";
  return (
    ["Full", "Charging", "Not charging", "Good", "Low", "Critical"][data[0]] ??
    "Unavailable"
  );
}

export function batteryIndicator(
  level: string,
  response?: string,
): {
  label: string;
  tone: "neutral" | "good" | "warning";
} {
  const voltage = batteryReading(response);
  return {
    label:
      level === "Unavailable"
        ? voltage === "Unavailable"
          ? "No reading"
          : voltage
        : level,
    tone:
      level === "Full" || level === "Good"
        ? "good"
        : level === "Low" || level === "Critical"
          ? "warning"
          : "neutral",
  };
}

/** Estimates exist only after an acknowledged Depot acceptance. */
export function profileBatteryIndicator(level:string,response:string|undefined,estimate:{percent:number;at:number}|undefined,now=Date.now(),state='ready') {
 const reported=batteryIndicator(level,response);
 if(!estimate||state!=='ready'||!Number.isFinite(estimate.percent)||estimate.percent<0||estimate.percent>100||now<estimate.at||now-estimate.at>120000||['Full','Charging'].includes(level)||
  (level==='Low'&&estimate.percent>20)||(level==='Critical'&&estimate.percent>10))return reported;
 return {label:`~${estimate.percent}%`,tone:reported.tone};
}
