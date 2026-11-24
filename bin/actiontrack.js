#!/usr/bin/env node
// Entry shim: silences node:sqlite's "experimental" notice (only that one), then runs the CLI.
const emit = process.emitWarning;
process.emitWarning = function patched(warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(String(warning))) return undefined;
  return emit.call(process, warning, ...args);
};

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2));
