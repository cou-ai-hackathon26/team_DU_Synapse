import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizedFactories,
  evidenceStatusCounts,
  officialEvidenceStatus,
} from "../lib/evidence-intelligence.ts";

function result(outcome) {
  return {
    id: outcome,
    outcome,
    claim: {},
    evidence: [],
    reviews: [],
  };
}

test("backend outcomes use only authoritative evidence categories", () => {
  assert.equal(officialEvidenceStatus("supported"), "Supported");
  assert.equal(officialEvidenceStatus("contradicted"), "Contradictory");
  assert.equal(officialEvidenceStatus("unresolved"), "Unresolved");
  assert.equal(officialEvidenceStatus("unsupported"), "Insufficient Evidence");
  assert.equal(officialEvidenceStatus("needs_review"), null);
  assert.equal(officialEvidenceStatus("not_assessed"), null);
});

test("status counts exclude outcomes without an official mapping", () => {
  const summary = evidenceStatusCounts([
    result("supported"),
    result("unsupported"),
    result("needs_review"),
  ]);
  assert.equal(summary.counts.Supported, 1);
  assert.equal(summary.counts["Insufficient Evidence"], 1);
  assert.equal(summary.classified, 2);
  assert.equal(summary.unclassified, 1);
});

test("factory choices come only from authorized cases", () => {
  assert.deepEqual(
    authorizedFactories([
      { factory: "Orion Garments", id: "1" },
      { factory: "Orion Garments", id: "2" },
      { factory: "Delta Textiles", id: "3" },
    ]),
    ["Orion Garments", "Delta Textiles"],
  );
});
