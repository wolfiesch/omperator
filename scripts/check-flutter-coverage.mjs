import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_REPORT = resolve(import.meta.dirname, "../apps/flutter/coverage/lcov.info");
const DEFAULT_MINIMUM_PERCENT = 65;

function boundedPercentage(value, label) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
		throw new Error(`${label} must be a finite percentage between 0 and 100`);
	}
	return parsed;
}

export function flutterLineCoverage(lcov) {
	if (typeof lcov !== "string" || lcov.length === 0) throw new Error("LCOV report is empty");
	const files = new Map();
	let source;
	for (const rawLine of lcov.split(/\r?\n/u)) {
		if (rawLine.startsWith("SF:")) {
			source = rawLine.slice(3);
			if (source.length === 0) throw new Error("LCOV source path is empty");
			if (!files.has(source)) files.set(source, new Map());
			continue;
		}
		if (!rawLine.startsWith("DA:")) continue;
		if (source === undefined) throw new Error("LCOV line data appeared before a source file");
		const match = /^DA:(\d+),(\d+)(?:,.*)?$/u.exec(rawLine);
		if (match === null) throw new Error(`Malformed LCOV line data: ${rawLine}`);
		const line = Number(match[1]);
		const hits = Number(match[2]);
		if (!Number.isSafeInteger(line) || line <= 0 || !Number.isSafeInteger(hits) || hits < 0) {
			throw new Error(`Invalid LCOV line data: ${rawLine}`);
		}
		const lines = files.get(source);
		lines.set(line, Math.max(lines.get(line) ?? 0, hits));
	}
	let found = 0;
	let covered = 0;
	for (const lines of files.values()) {
		found += lines.size;
		for (const hits of lines.values()) if (hits > 0) covered += 1;
	}
	if (found === 0) throw new Error("LCOV report contains no executable lines");
	return { covered, found, percent: (covered / found) * 100 };
}

export function requireFlutterLineCoverage(lcov, minimumPercent = DEFAULT_MINIMUM_PERCENT) {
	const minimum = boundedPercentage(minimumPercent, "minimum coverage");
	const result = flutterLineCoverage(lcov);
	if (result.percent + Number.EPSILON < minimum) {
		throw new Error(
			`Flutter line coverage ${result.percent.toFixed(2)}% (${result.covered}/${result.found}) is below ${minimum.toFixed(2)}%`,
		);
	}
	return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	const report = process.argv[2] ?? DEFAULT_REPORT;
	const minimum = process.argv[3] ?? DEFAULT_MINIMUM_PERCENT;
	try {
		const result = requireFlutterLineCoverage(readFileSync(report, "utf8"), minimum);
		console.log(`Flutter line coverage ${result.percent.toFixed(2)}% (${result.covered}/${result.found})`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
