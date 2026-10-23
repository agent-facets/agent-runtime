// The MCP server programs this deployment ships. Each entry is an explicitly selected, owner-reviewed server whose
// dependencies are pinned in this package; the builder turns it into one self-contained Bun bundle. No production
// server is selected yet, and synthetic test servers (test-support/) are never listed here.

export interface ProgramEntry {
  /** The program ID operator configuration binds (`localPrograms`). */
  id: string;
  /** The entry module, relative to this package. */
  entry: string;
}

export const PROGRAMS: readonly ProgramEntry[] = Object.freeze([]);
