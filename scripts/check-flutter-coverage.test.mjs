import assert from "node:assert/strict";
import test from "node:test";

import { flutterLineCoverage, requireFlutterLineCoverage } from "./check-flutter-coverage.mjs";

const REPORT = `TN:
SF:lib/a.dart
DA:1,1
DA:2,0
end_of_record
SF:lib/b.dart
DA:4,3
DA:5,0
end_of_record
`;

test("computes line coverage across source records", () => {
	assert.deepEqual(flutterLineCoverage(REPORT), { covered: 2, found: 4, percent: 50 });
});

test("deduplicates repeated source lines using the highest hit count", () => {
	const repeated = `${REPORT}SF:lib/a.dart\nDA:1,0\nDA:2,2\nend_of_record\n`;
	assert.deepEqual(flutterLineCoverage(repeated), { covered: 3, found: 4, percent: 75 });
});

test("enforces the configured minimum", () => {
	assert.equal(requireFlutterLineCoverage(REPORT, 50).percent, 50);
	assert.throws(() => requireFlutterLineCoverage(REPORT, 50.01), /below 50\.01%/u);
});

test("rejects empty and malformed reports", () => {
	assert.throws(() => flutterLineCoverage(""), /empty/u);
	assert.throws(() => flutterLineCoverage("DA:1,1\n"), /before a source/u);
	assert.throws(() => flutterLineCoverage("SF:lib/a.dart\nDA:nope\n"), /Malformed/u);
	assert.throws(() => flutterLineCoverage("SF:lib/a.dart\n"), /no executable lines/u);
});
