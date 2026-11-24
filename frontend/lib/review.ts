import type { CapAnalysis, CapReview, Result, Run } from "./api";

export function capFindingLinks(analysis: CapAnalysis, reviews: CapReview[], findingId: string) {
  const suggestions = new Map(analysis.suggestions
    .filter((suggestion) => suggestion.finding_id === findingId)
    .map((suggestion) => [suggestion.action_id, suggestion]));
  const decisions = new Map(reviews
    .filter((review) => review.finding_id === findingId)
    .map((review) => [review.action_id, review]));
  return analysis.actions.flatMap((action) => {
    const suggestion = suggestions.get(action.id);
    const review = decisions.get(action.id);
    return suggestion || review ? [{ action, suggestion, review }] : [];
  });
}

export function capLinkStatus({ suggestion, review }: ReturnType<typeof capFindingLinks>[number]) {
  if (review) return review.decision === "confirm" ? "Link confirmed" : "Link dismissed";
  if (suggestion?.basis === "explicit_reference_conflict") return "FI reference · check mismatch";
  if (suggestion?.basis === "explicit_reference") return "Explicit reference";
  return "Possible match";
}

export function lastReviewAction(result: Result) {
  return result.reviews.findLast((event) => event.action !== "comment");
}

export function reviewStatus(result: Result) {
  const last = lastReviewAction(result);
  switch (last?.action) {
    case "accept":
      return "Accepted";
    case "dismiss":
      return "Dismissed";
    case "request_evidence":
      return "Evidence requested";
    default:
      return "Pending review";
  }
}

export function reviewableRuns(runs: Run[]) {
  return runs.filter(
    (run) => run.status === "complete" || run.status === "partial",
  );
}

export function compareDocuments(older: Run, newer: Run) {
  const previous = new Map(older.manifest.map((doc) => [doc.document_id, doc]));
  const current = new Map(newer.manifest.map((doc) => [doc.document_id, doc]));
  const changes = [];
  for (const doc of newer.manifest) {
    const before = previous.get(doc.document_id);
    if (before?.id === doc.id) continue;
    changes.push({
      title: doc.title,
      id: doc.document_id,
      from: before?.revision ?? null,
      to: doc.revision,
    });
  }
  for (const doc of older.manifest) {
    if (!current.has(doc.document_id)) {
      changes.push({
        title: doc.title,
        id: doc.document_id,
        from: doc.revision,
        to: null,
      });
    }
  }
  return changes;
}

type Change = { before: Result | null; after: Result | null };
const findingPrefix =
  /^finding\s+(?:id\s*)?[:#]?\s*([a-z]{1,8}[-/]\d{1,8})\s*[.:]\s*/iu;

function citedFindingId(row: Result) {
  if (row.claim.kind !== "finding") return undefined;
  return row.claim.source.quote.trim().match(findingPrefix)?.[1].toLowerCase();
}

export function compareResults(
  older: Run,
  newer: Run,
  first: Result[],
  second: Result[],
) {
  function group(run: Run, rows: Result[]) {
    const versions = new Map(
      run.manifest.map((doc) => [doc.id, doc.document_id]),
    );
    const groups = new Map<string, Result[]>();
    for (const row of rows) {
      const original = row.claim.source.quote
        .normalize("NFC")
        .replace(/\s+/gu, " ")
        .trim();
      const quote =
        row.claim.kind === "finding"
          ? original.replace(findingPrefix, "")
          : original;
      const key = JSON.stringify([
        versions.get(row.claim.source.version_id) ||
          row.claim.source.version_id,
        row.claim.kind,
        quote,
      ]);
      const existing = groups.get(key) || [];
      existing.push(row);
      groups.set(key, existing);
    }
    return groups;
  }
  const previous = group(older, first);
  const current = group(newer, second);
  const changes: Change[] = [];
  let unchanged = 0;
  for (const key of new Set([...previous.keys(), ...current.keys()])) {
    const before = previous.get(key) || [];
    const after = current.get(key) || [];
    if (before.length === 1 && after.length === 1) {
      const previousId = citedFindingId(before[0]);
      const currentId = citedFindingId(after[0]);
      if (previousId && currentId && previousId !== currentId) {
        changes.push(
          { before: before[0], after: null },
          { before: null, after: after[0] },
        );
      } else if (before[0].outcome === after[0].outcome) unchanged += 1;
      else changes.push({ before: before[0], after: after[0] });
      continue;
    }
    // Repeated quotations cannot establish a one-to-one match across snapshots.
    if (before.length && after.length) {
      const matched = new Set<string>();
      for (const entry of before) {
        const ref = entry.claim.source;
        const corresponding = after.filter((row) => {
          const next = row.claim.source;
          return (
            ref.version_id === next.version_id &&
            ref.page === next.page &&
            ref.start === next.start
          );
        });
        if (corresponding.length !== 1 || matched.has(corresponding[0].id)) {
          changes.push({ before: entry, after: null });
          continue;
        }
        const next = corresponding[0];
        matched.add(next.id);
        if (entry.outcome === next.outcome) unchanged += 1;
        else changes.push({ before: entry, after: next });
      }
      for (const entry of after) {
        if (!matched.has(entry.id))
          changes.push({ before: null, after: entry });
      }
      continue;
    }
    for (const entry of before) changes.push({ before: entry, after: null });
    for (const entry of after) changes.push({ before: null, after: entry });
  }
  return { changes, unchanged };
}
