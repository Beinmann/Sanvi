// Tiny DOM-free helpers shared by the frontend modules (and unit-tested).

/** Flatten `nodes` and drop null/undefined/false, which `replaceChildren` would otherwise print as text ("null"). */
export function compact(...nodes) {
  return nodes.flat(Infinity).filter((n) => n != null && n !== false);
}
