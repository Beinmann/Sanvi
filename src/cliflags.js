// Shorthand flags of `tk serve` / `tk start`, expanded right after parsing so every later check and the
// flags `start` forwards to the background process see the long forms.

/** `--agents-full` is `--agents --auto-refine`. Mutates and returns `flags`. */
export function expandFlags(flags) {
  if (flags['agents-full']) { flags.agents = true; flags['auto-refine'] = true; }
  return flags;
}
