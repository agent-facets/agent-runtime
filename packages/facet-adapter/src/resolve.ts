// Resolves explicitly declared references through the recorded alias/omission choices (design Decision 3). Nothing
// is inferred from prose, nothing is installed, and installation order never chooses between candidates. A
// contribution with an unusable prerequisite is refused; unrelated contributions are unaffected.
import type { AssetKind, AuthoredRequirement, AuthoredRestriction, RuntimeMetadata } from './metadata.ts';

export interface ResolvableItem {
  facet: string;
  kind: AssetKind;
  authoredName: string;
  /** Absent when the project omits the item. */
  effectiveName?: string;
  /** Present for items that exported as ready; absent for refused or omitted items. */
  runtime?: RuntimeMetadata;
}

export type ResolvedRequirement =
  | { kind: 'skill'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'native'; name: string };

export interface ResolvedRestriction {
  native?: string[];
  skills?: string[];
  agents?: string[];
  mcp?: [];
}

export type Resolution =
  | { ok: true; requires: ResolvedRequirement[]; restrict?: ResolvedRestriction }
  | { ok: false; reason: string; subject?: string; fields: string[] };

const keyOf = (facet: string, kind: string, name: string) => `${facet}\u0000${kind}\u0000${name}`;
export const itemKey = (item: ResolvableItem) => keyOf(item.facet, item.kind, item.authoredName);
const idOf = (item: ResolvableItem) => `${item.kind}:${item.effectiveName}`;
const refLabel = (facet: string, kind: string, name: string) => `${kind}:${facet}/${name}`;

/**
 * Resolves every item that exported as ready. Items that exported as refused have no resolution, so depending on
 * one is itself a refusal.
 */
export function resolveReferences(items: readonly ResolvableItem[]): Map<string, Resolution> {
  const index = new Map(items.map((item) => [itemKey(item), item]));
  const results = new Map<string, Resolution>();
  const edges = new Map<string, string[]>();

  for (const item of items) {
    if (item.runtime === undefined || item.effectiveName === undefined) continue;
    const local = resolveLocal(item, item.runtime, index);
    results.set(itemKey(item), local.resolution);
    edges.set(itemKey(item), local.dependsOn);
  }

  // Requirement cycles make every member unusable rather than letting one side win.
  for (const key of cycleMembers(edges)) {
    if (results.get(key)?.ok) results.set(key, { ok: false, reason: 'requirement_cycle', fields: ['requires'] });
  }

  // A refused, omitted or cyclic prerequisite makes its dependants unusable, transitively.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, dependsOn] of edges) {
      if (!results.get(key)?.ok) continue;
      const blocked = dependsOn.find((target) => !results.get(target)?.ok);
      if (blocked !== undefined) {
        const target = index.get(blocked);
        results.set(key, {
          ok: false,
          reason: 'prerequisite_refused',
          subject: target === undefined ? undefined : refLabel(target.facet, target.kind, target.authoredName),
          fields: ['requires'],
        });
        changed = true;
      }
    }
  }
  return results;
}

function resolveLocal(
  item: ResolvableItem,
  runtime: RuntimeMetadata,
  index: Map<string, ResolvableItem>,
): { resolution: Resolution; dependsOn: string[] } {
  const dependsOn: string[] = [];
  const requires: ResolvedRequirement[] = [];
  const refuse = (reason: string, field: string, subject?: string) => ({
    resolution: { ok: false as const, reason, subject, fields: [field] },
    dependsOn: [],
  });

  for (const requirement of runtime.requires) {
    const resolved = resolveRequirement(item, requirement, index);
    if ('refusal' in resolved) return refuse(resolved.refusal, 'requires', resolved.subject);
    requires.push(resolved.requirement);
    if (resolved.target !== undefined) dependsOn.push(resolved.target);
  }

  let restrict: ResolvedRestriction | undefined;
  if (runtime.restrict !== undefined) {
    const resolved = resolveRestriction(item, runtime.restrict, index);
    if ('refusal' in resolved) return refuse(resolved.refusal, 'restrict', resolved.subject);
    restrict = resolved.restrict;
  }
  return { resolution: { ok: true, requires, ...(restrict === undefined ? {} : { restrict }) }, dependsOn };
}

type Resolved<T> = T | { refusal: string; subject?: string };

function resolveRequirement(
  item: ResolvableItem,
  requirement: AuthoredRequirement,
  index: Map<string, ResolvableItem>,
): Resolved<{ requirement: ResolvedRequirement; target?: string }> {
  if (requirement.kind === 'native') return { requirement: { kind: 'native', name: requirement.name } };
  if (requirement.kind === 'mcp') {
    // TODO UPSTREAM-SERVER-PROVENANCE: revisit 9.1; complete 10.1; verify 10.2. Binding an authored server to its
    // effective declaration needs public per-facet server provenance, so MCP references are refused for now.
    return { refusal: 'server_provenance_unavailable', subject: `mcp:${requirement.server}/${requirement.tool}` };
  }
  const facet = requirement.facet ?? item.facet;
  const target = index.get(keyOf(facet, requirement.kind, requirement.name));
  const subject = refLabel(facet, requirement.kind, requirement.name);
  if (target === undefined) return { refusal: 'prerequisite_missing', subject };
  if (target.effectiveName === undefined) return { refusal: 'prerequisite_omitted', subject };
  return { requirement: { kind: requirement.kind, id: idOf(target) }, target: itemKey(target) };
}

function resolveRestriction(
  item: ResolvableItem,
  restrict: AuthoredRestriction,
  index: Map<string, ResolvableItem>,
): Resolved<{ restrict: ResolvedRestriction }> {
  const resolved: ResolvedRestriction = {};
  if (restrict.native !== undefined) resolved.native = [...new Set(restrict.native)];
  for (const [field, kind] of [
    ['skills', 'skill'],
    ['agents', 'agent'],
  ] as const) {
    const refs = restrict[field];
    if (refs === undefined) continue;
    const ids = new Set<string>();
    for (const ref of refs) {
      const facet = ref.facet ?? item.facet;
      const target = index.get(keyOf(facet, kind, ref.name));
      if (target === undefined) return { refusal: 'reference_unresolved', subject: refLabel(facet, kind, ref.name) };
      // An omitted item is never available, so allowing it permits nothing; dropping it cannot widen access.
      if (target.effectiveName !== undefined) ids.add(idOf(target));
    }
    resolved[field] = [...ids];
  }
  if (restrict.mcp !== undefined) {
    const [first] = restrict.mcp;
    if (first !== undefined) {
      // TODO UPSTREAM-SERVER-PROVENANCE: revisit 9.1; complete 10.1; verify 10.2.
      return { refusal: 'server_provenance_unavailable', subject: `mcp:${first.server}/${first.tool}` };
    }
    resolved.mcp = [];
  }
  return { restrict: resolved };
}

/** Every node on a directed cycle (Tarjan's strongly connected components, including self-loops). */
function cycleMembers(edges: Map<string, string[]>): Set<string> {
  const members = new Set<string>();
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;
  const visit = (node: string) => {
    indexOf.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) continue;
      if (!indexOf.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) low.set(node, Math.min(low.get(node) ?? 0, indexOf.get(next) ?? 0));
    }
    if (low.get(node) === indexOf.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || (edges.get(node) ?? []).includes(node)) for (const m of component) members.add(m);
    }
  };
  for (const node of edges.keys()) if (!indexOf.has(node)) visit(node);
  return members;
}
