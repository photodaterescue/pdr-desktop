// TypeScript-only declaration shim so main-process (ESM) files can
// `import { x } from './date-extraction-engine.cjs'`. The .cjs file is
// the actual compiled CommonJS output (compiled by tsconfig.worker.json
// + renamed in build:electron). Both the worker and the main process
// require/import from this same .cjs at runtime; this declaration
// provides the types for the ESM-side imports.
export * from './date-extraction-engine';
