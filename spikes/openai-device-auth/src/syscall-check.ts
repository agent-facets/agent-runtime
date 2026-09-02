// Independent verification of the write sequence.
//
// This parses a kernel-level strace, not the application's own logging. That
// distinction is the entire value: a store that *reports* calling fsync and a
// store that *calls* fsync are indistinguishable from inside the process, and
// the thing being tested is precisely whether the durable sequence really
// happens.
//
// An empty or unparsable trace is a harness fault, never a pass.

export type TraceEvent = {
  index: number;
  call: string;
  args: string;
  paths: string[];
  mode: number | null;
  flags: string[];
};

export type TraceFindings = {
  events: number;
  tempSameDirectory: boolean;
  tempExclusiveCreate: boolean;
  modeAtCreate: boolean;
  noChmodOnCredential: boolean;
  fsyncBeforeRename: boolean;
  renameUsed: boolean;
  noTruncateOnTarget: boolean;
  directoryFsyncAfterRename: boolean;
  flockObserved: boolean;
  writesConfinedToStore: boolean;
  problems: string[];
};

// `strace -f` prefixes each line with the pid, bare and space-padded when
// writing to a file (`10    openat(...)`) and bracketed when writing to a
// terminal. Both spellings have to be accepted, or the parser silently reports
// an empty trace and the check passes for the wrong reason.
const CALL_PATTERN = /^(?:\[pid\s+\d+\]\s*|\d+\s+)?(\w+)\((.*)$/;

export function parseTrace(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  let index = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("---") || trimmed.startsWith("+++")) continue;

    const match = CALL_PATTERN.exec(trimmed);
    if (!match) continue;

    const call = match[1] as string;
    const args = match[2] as string;

    const paths = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((entry) => entry[1] as string);
    // `strace -y` annotates descriptors as 3</abs/path>; those are paths too.
    paths.push(...[...args.matchAll(/\d+<([^>]+)>/g)].map((entry) => entry[1] as string));

    const modeMatch = /,\s*(0[0-7]{3,4})\s*\)/.exec(args);
    const flags = (args.match(/O_[A-Z_]+/g) ?? []) as string[];

    events.push({
      index,
      call,
      args,
      paths,
      mode: modeMatch ? Number.parseInt(modeMatch[1] as string, 8) : null,
      flags,
    });
    index += 1;
  }

  return events;
}

export function verifyTrace(
  text: string,
  target: string,
  storeDirectory: string,
): TraceFindings {
  const events = parseTrace(text);
  const problems: string[] = [];

  const touches = (event: TraceEvent, path: string) =>
    event.paths.some((candidate) => candidate === path);

  const tempCreates = events.filter(
    (event) =>
      (event.call === "openat" || event.call === "open") &&
      event.paths.some((path) => path.startsWith(`${target}.`) && path.endsWith(".tmp")),
  );

  const renames = events.filter(
    (event) =>
      (event.call === "rename" || event.call === "renameat" || event.call === "renameat2") &&
      touches(event, target),
  );

  const fsyncs = events.filter((event) => event.call === "fsync" || event.call === "fdatasync");

  const tempPath = tempCreates[0]?.paths.find(
    (path) => path.startsWith(`${target}.`) && path.endsWith(".tmp"),
  );

  const tempFsyncIndex = tempPath
    ? (fsyncs.find((event) => touches(event, tempPath))?.index ?? -1)
    : -1;
  const renameIndex = renames[0]?.index ?? -1;
  const directoryFsyncIndex =
    fsyncs.find((event) => event.index > renameIndex && touches(event, storeDirectory))?.index ?? -1;

  if (events.length === 0) problems.push("trace is empty; the tracer observed nothing");
  if (tempCreates.length === 0) problems.push("no temp file was created next to the target");
  if (renames.length === 0) problems.push("no rename onto the target was observed");

  const tempSameDirectory = tempPath
    ? tempPath.slice(0, tempPath.lastIndexOf("/")) === storeDirectory
    : false;
  const tempExclusiveCreate = tempCreates.some(
    (event) => event.flags.includes("O_EXCL") && event.flags.includes("O_CREAT"),
  );
  const modeAtCreate = tempCreates.some((event) => event.mode === 0o600);

  const noChmodOnCredential = !events.some(
    (event) =>
      (event.call === "chmod" || event.call === "fchmod" || event.call === "fchmodat") &&
      event.paths.some((path) => path.startsWith(target)),
  );

  const noTruncateOnTarget = !events.some(
    (event) =>
      touches(event, target) &&
      (event.call === "ftruncate" || event.flags.includes("O_TRUNC")),
  );

  const fsyncBeforeRename =
    tempFsyncIndex >= 0 && renameIndex >= 0 && tempFsyncIndex < renameIndex;
  const directoryFsyncAfterRename = directoryFsyncIndex > renameIndex;

  const flockObserved = events.some((event) => event.call === "flock");

  const writesConfinedToStore = !events.some(
    (event) =>
      (event.call === "openat" || event.call === "open") &&
      (event.flags.includes("O_WRONLY") || event.flags.includes("O_RDWR")) &&
      event.paths.some(
        (path) => path.startsWith("/") && !path.startsWith(storeDirectory) && !isBenign(path),
      ),
  );

  if (!tempSameDirectory) problems.push("temp file is not in the target's directory");
  if (!tempExclusiveCreate) problems.push("temp file was not created with O_CREAT|O_EXCL");
  if (!modeAtCreate) problems.push("temp file was not created with mode 0600");
  if (!noChmodOnCredential) problems.push("a chmod touched the credential path");
  if (!fsyncBeforeRename) problems.push("fsync did not precede the rename");
  if (!noTruncateOnTarget) problems.push("the live target was truncated");
  if (!directoryFsyncAfterRename) problems.push("the directory was not fsynced after the rename");
  if (!writesConfinedToStore) problems.push("a write escaped the store directory");

  return {
    events: events.length,
    tempSameDirectory,
    tempExclusiveCreate,
    modeAtCreate,
    noChmodOnCredential,
    fsyncBeforeRename,
    renameUsed: renames.length > 0,
    noTruncateOnTarget,
    directoryFsyncAfterRename,
    flockObserved,
    writesConfinedToStore,
    problems,
  };
}

/** Runtime and tracer plumbing that is not a credential write. */
function isBenign(path: string): boolean {
  return (
    path.startsWith("/dev/") ||
    path.startsWith("/proc/") ||
    path.startsWith("/sys/") ||
    path.startsWith("/tmp/strace") ||
    path === "/dev/null"
  );
}
