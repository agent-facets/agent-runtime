// A simulation of the pinned MCP Connector's native write path.
//
// This does NOT drive Obsidian. Spike 01 established that the plugin can be run
// headlessly, but its GUI surfaces — Properties, Bases, Graph View, Canvas —
// cannot be, and crediting Lane M with a correction path that was never
// exercised would be the single easiest way to bias this comparison. What is
// modelled here is the connector's *measured* write semantics, read out of the
// pinned bundle during Step 3 rather than out of its documentation:
//
//   - `requireWritePreconditions` DEFAULTS TO FALSE. With it off, a whole-file
//     write silently overwrites whatever it lands on. That default is the
//     hazard, and it is measured here rather than assumed away.
//   - With it on, the compare-and-swap is real and fails with a stale
//     precondition.
//   - Its whitespace normalisation is narrow: CRLF, trailing horizontal
//     whitespace, and leading/trailing blank lines only. A reformat-on-save
//     therefore produces a spurious conflict, which is modelled faithfully
//     rather than smoothed over.
//
// Anything this file cannot honestly model is reported as a capability gap, not
// as a passing check.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type NativeWriteResult =
  | { outcome: "written" }
  | { outcome: "stale_precondition"; observedLength: number }
  | { outcome: "not_found" };

/** The connector's normalisation, reproduced exactly — including how narrow it is. */
export function normalizeForPrecondition(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * A whole-file native write.
 *
 * `expectedContent` is honoured only when `requireWritePreconditions` is on,
 * which is exactly how the plugin behaves and exactly why the setting has to be
 * enabled before this lane can be credited with a guarded correction path.
 */
export function nativeWrite(
  path: string,
  body: string,
  options: { requireWritePreconditions: boolean; expectedContent?: string },
): NativeWriteResult {
  if (!existsSync(path)) return { outcome: "not_found" };
  const current = readFileSync(path, "utf8");

  if (options.requireWritePreconditions) {
    const expected = options.expectedContent ?? "";
    if (normalizeForPrecondition(expected) !== normalizeForPrecondition(current)) {
      return { outcome: "stale_precondition", observedLength: current.length };
    }
  }

  const temporary = `${path}.native.tmp`;
  writeFileSync(temporary, body, "utf8");
  renameSync(temporary, path);
  return { outcome: "written" };
}

export type SurfaceField = {
  name: string;
  shape: "scalar" | "list_of_scalars" | "nested";
  /**
   * Obsidian Properties has no nested type, so a nested value cannot be shown or
   * edited in Properties or Bases at all. It is not "hard to read" — it is
   * absent from the surface.
   */
  representableInProperties: boolean;
};

export type SurfaceReport = {
  total: number;
  representable: number;
  absent: string[];
  fields: SurfaceField[];
};

/**
 * What a native property surface could actually show for one record.
 *
 * Computed from the record rather than asserted, so the finding is a measurement
 * of this contract's shape and not a recollection of the documentation.
 */
export function surfaceReport(record: Record<string, unknown>): SurfaceReport {
  const fields: SurfaceField[] = Object.entries(record).map(([name, value]) => {
    if (Array.isArray(value)) {
      const scalars = value.every(
        (entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry),
      );
      return {
        name,
        shape: scalars ? "list_of_scalars" : "nested",
        representableInProperties: scalars,
      };
    }
    if (value !== null && typeof value === "object") {
      return { name, shape: "nested", representableInProperties: false };
    }
    return { name, shape: "scalar", representableInProperties: true };
  });

  return {
    total: fields.length,
    representable: fields.filter((field) => field.representableInProperties).length,
    absent: fields.filter((field) => !field.representableInProperties).map((field) => field.name),
    fields,
  };
}
