from collections import defaultdict

from .verify import (
    finding_reference, finding_scope_conflicts, is_closure_statement, later_closure_citation,
)


def hazard_histories(runs, results, visible_versions):
    """Build the inspection series from published, source-anchored assessments."""
    manifests = {run["id"]: {v["id"]: v for v in run["manifest"]} for run in runs}
    events = defaultdict(dict)

    for row in results:
        target = row["claim"]
        if target["kind"] != "finding":
            continue
        source = target["source"]
        reference = finding_reference(source["quote"])
        versions = manifests[row["run_id"]]
        original = versions.get(source["version_id"])
        if (
            not reference or is_closure_statement(source["quote"])
            or not original or original["role"] != "inspection"
            or original["issuer"] != "external" or not original.get("issued_on")
            or original["id"] not in visible_versions
        ):
            continue

        observed_on = original["issued_on"]
        kind = "document_review" if target.get("documentary_carry_forward") else "observation"
        events[reference][(observed_on, kind, source["quote"])] = {
            "date": observed_on, "source": source,
        }
        checks = row["checks"]
        if row["outcome"] != "supported" or not (
            checks.get("secondary") == "entails"
            or checks.get("closure") == "explicit_independent_inspection"
        ):
            continue

        for citation in row["evidence"]:
            verification = versions.get(citation["version_id"])
            if (
                not verification or verification["id"] not in visible_versions
                or not later_closure_citation(original, verification, target, citation["quote"])
                or finding_scope_conflicts(source["quote"], citation["quote"])
            ):
                continue
            date = verification["issued_on"]
            events[reference][(date, "verification", observed_on, citation["quote"])] = {
                "date": date, "source": citation, "verifies_observation": observed_on,
                "observation_quote": source["quote"],
            }

    histories = []
    for reference, records in sorted(events.items()):
        history = []
        episode_start = None
        latest_observation = None
        closed = False
        for key, event in sorted(records.items()):
            date, kind, *_ = key
            conflicting = history and finding_scope_conflicts(
                history[0]["source"]["quote"], event["source"]["quote"]
            )
            if conflicting:
                history.append({"date": date, "source": event["source"], "status": "needs_review"})
                continue
            if kind == "verification":
                if (
                    closed or episode_start is None
                    or event["verifies_observation"] < episode_start
                    or date == latest_observation
                    or finding_scope_conflicts(
                        history[0]["source"]["quote"], event["observation_quote"]
                    )
                ):
                    continue
                status = "closed"
                closed = True
            elif kind == "document_review":
                if closed or date == latest_observation:
                    continue
                if episode_start is None:
                    episode_start = date
                latest_observation = date
                status = "carried_forward"
            else:
                if date == latest_observation:
                    continue
                if episode_start is None or closed:
                    status = "reopened" if closed else "opened"
                    episode_start = date
                else:
                    status = "carried_forward"
                closed = False
                latest_observation = date
            history.append({"date": date, "source": event["source"], "status": status})
        histories.append({"finding_id": reference.upper(), "events": history})
    return histories
