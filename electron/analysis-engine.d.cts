// See date-extraction-engine.d.cts for the rationale. analysis-engine
// is compiled as CJS so the analysis-worker can require it; main-side
// callers see it as `./analysis-engine.cjs` via this shim.
export * from './analysis-engine';
