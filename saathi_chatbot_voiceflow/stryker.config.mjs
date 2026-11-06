/*
 * stryker.config.mjs: mutation testing for the Voiceflow function tools (Stryker, "command" test runner).
 *
 * What it does: Stryker makes small changes ("mutants") to the generated tools in 3_function_tools/ (flips a
 * comparison, empties a string, removes a block…) and runs the test suite against each. A mutant the tests notice is
 * "killed"; one they don't notice "survives" and points at a missing test. Which lines are mutated, and why, is
 * decided in 6_tests/mutation/scope.mjs (own code yes; user-facing MESSAGES and case DATA no).
 *
 * How to run: npm run test:mutation (about half an hour on 4 cores), then read the per-tool scores printed by
 * 6_tests/mutation/summarise.mjs, or open reports/mutation/mutation.html. The test suite runs with --mutation-run:
 * it stops at the first failure and skips the few checks that read source text Stryker rewrites.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strykerMutateEntries } from "./6_tests/mutation/scope.mjs";

const kitDirectory = path.dirname(fileURLToPath(import.meta.url));
/** Worst case for one full suite run on an instrumented copy is a few seconds; a mutant that loops forever is cut off. */
const TIMEOUT_MILLISECONDS = 15000;
const PARALLEL_RUNS = 4;

export default {
  testRunner: "command",
  commandRunner: { command: "node 6_tests/run_function_tests.mjs --mutation-run" },
  mutate: strykerMutateEntries(kitDirectory),
  coverageAnalysis: "off",
  concurrency: PARALLEL_RUNS,
  timeoutMS: TIMEOUT_MILLISECONDS,
  reporters: ["clear-text", "progress", "json", "html"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  ignorePatterns: ["reports", ".stryker-tmp"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
