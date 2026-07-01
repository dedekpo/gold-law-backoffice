// Deterministic screening engine — see docs/screening-spec.md.
// Re-exports the intake gate, the four screens, kill conditions, and volume.

export { evaluateIntakeGate } from "./gate";
export { runScreens, checkKillConditions, countVolume } from "./screens";
