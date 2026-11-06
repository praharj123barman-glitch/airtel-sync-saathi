/*
 * summarise.mjs: per-tool mutation scores from Stryker's JSON report, and the surviving mutants of the core tools.
 *
 * What it prints: for each region of 6_tests/mutation/scope.mjs (a tool's own code, or a shared module), the number
 * of mutants killed (a test failed), timed out (counted as killed: the change broke the tool), survived (no test
 * noticed) and the mutation score = killed / (killed + survived + no coverage). Then, for the core tools, every
 * surviving mutant with its line, what Stryker changed and the original code, so missing tests can be written.
 *
 * How it fits: npm run test:mutation runs Stryker, then this. Usage: node 6_tests/mutation/summarise.mjs [report]
 * (default report: reports/mutation/mutation.json). Optional: --survivors=<region label> to list one region only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MUTATED_TOOLS, CORE_REGIONS, FUNCTION_TOOLS_DIRECTORY, regionsOf } from "./scope.mjs";

// ================================================================ CONFIG

const DEFAULT_REPORT = path.join("reports", "mutation", "mutation.json");
const DETECTED = ["Killed", "Timeout"];
const UNDETECTED = ["Survived", "NoCoverage"];
const PERCENT = 100;
const SNIPPET_LENGTH = 70;

// ================================================================ LOGIC

/** The region label of a mutant, from its file and start line. */
function regionOf(regionsByFile, fileName, line) {
  for (const region of regionsByFile[fileName] || []) {
    if (region.spans.some(([start, end]) => line >= start && line <= end)) return region.label;
  }
  return fileName + " (outside the planned scope)";
}

function percentage(part, whole) {
  return whole ? ((PERCENT * part) / whole).toFixed(1) + "%" : "n/a";
}

/** The original code a mutant replaced (one line, shortened). */
function originalSnippet(sourceLines, location) {
  const line = sourceLines[location.start.line - 1] || "";
  return line.trim().slice(0, SNIPPET_LENGTH);
}

function main() {
  const kitDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const reportPath = process.argv.find((argument, index) => index > 1 && !argument.startsWith("--")) || DEFAULT_REPORT;
  const onlyRegion = (process.argv.find((argument) => argument.startsWith("--survivors=")) || "").replace(
    "--survivors=",
    "",
  );
  const report = JSON.parse(fs.readFileSync(path.resolve(kitDirectory, reportPath), "utf8"));
  const regionsByFile = {};
  for (const tool of MUTATED_TOOLS) regionsByFile[tool.file] = regionsOf(kitDirectory, tool);

  const tally = {};
  const survivors = {};
  for (const [filePath, fileResult] of Object.entries(report.files)) {
    const fileName = path.basename(filePath);
    const sourceLines = fileResult.source.split(/\r?\n/);
    for (const mutant of fileResult.mutants) {
      const region = regionOf(regionsByFile, fileName, mutant.location.start.line);
      const counts = (tally[region] = tally[region] || { detected: 0, undetected: 0, ignored: 0 });
      if (DETECTED.includes(mutant.status)) counts.detected++;
      else if (UNDETECTED.includes(mutant.status)) {
        counts.undetected++;
        (survivors[region] = survivors[region] || []).push({
          line: mutant.location.start.line,
          mutator: mutant.mutatorName,
          replacement: String(mutant.replacement || "")
            .replace(/\s+/g, " ")
            .slice(0, SNIPPET_LENGTH),
          original: originalSnippet(sourceLines, mutant.location),
          file: `${FUNCTION_TOOLS_DIRECTORY}/${fileName}`,
        });
      } else counts.ignored++;
    }
  }

  let allDetected = 0;
  let allUndetected = 0;
  console.log("region".padEnd(38) + "mutants  killed  survived  score");
  for (const [region, counts] of Object.entries(tally).sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = counts.detected + counts.undetected;
    allDetected += counts.detected;
    allUndetected += counts.undetected;
    console.log(
      region.padEnd(38) +
        String(total).padStart(7) +
        String(counts.detected).padStart(8) +
        String(counts.undetected).padStart(10) +
        percentage(counts.detected, total).padStart(8) +
        (CORE_REGIONS.includes(region) ? "  (core)" : ""),
    );
  }
  console.log(
    "ALL".padEnd(38) +
      String(allDetected + allUndetected).padStart(7) +
      String(allDetected).padStart(8) +
      String(allUndetected).padStart(10) +
      percentage(allDetected, allDetected + allUndetected).padStart(8),
  );

  const listed = onlyRegion ? [onlyRegion] : CORE_REGIONS;
  for (const region of listed) {
    const list = (survivors[region] || []).sort((a, b) => a.line - b.line);
    console.log(`\nSurviving mutants in ${region}: ${list.length}`);
    for (const survivor of list) {
      console.log(
        `  ${survivor.file}:${survivor.line}  ${survivor.mutator}: ${survivor.original}  →  ${survivor.replacement}`,
      );
    }
  }
}

main();
