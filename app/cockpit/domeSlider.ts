/** The track midpoint represents zero despite the droid's asymmetric dome limits. */
export function domeSliderPosition(angle: number) {
    const n = Math.max(-160, Math.min(180, angle));
    return n / (n < 0 ? 160 : 180) * 100;
}
export function domeSliderTarget(position: number, snap = true): number | undefined {
    if (!Number.isFinite(position))
        return;
    const n = Math.max(-100, Math.min(100, position));
    if (snap && Math.abs(n) <= 10)
        return 0;
    return Math.round(n * (n < 0 ? 160 : 180) / 100) || 0;
}
