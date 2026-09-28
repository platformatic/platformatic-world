import { settle } from './rmt1-workflow'

// Import and re-export the workflow without calling start(). RMT-1 uses the
// compiler output for this file to distinguish import-time metadata from a
// run created at execution time.
export const importedWorkflow = settle
