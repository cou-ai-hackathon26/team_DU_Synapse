"""Verification policy shared by the live worker and evaluation tooling."""

import re
import unicodedata
from datetime import date
from uuid import UUID, uuid5
from .ai import BLIND, EXTRACT, VERIFY, InferenceFailure, digest
from .models import TargetList, Verdict, SecondOpinion

DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")
ABSENCE_LIMIT = 52000
MONTHS = (
    ("january", "jan", "জানুয়ারি", "জানুয়ারি"),
    ("february", "feb", "ফেব্রুয়ারি", "ফেব্রুয়ারি"),
    ("march", "mar", "মার্চ"),
    ("april", "apr", "এপ্রিল"),
    ("may", "মে"),
    ("june", "jun", "জুন"),
    ("july", "jul", "জুলাই"),
    ("august", "aug", "আগস্ট"),
    ("september", "sep", "সেপ্টেম্বর"),
    ("october", "oct", "অক্টোবর"),
    ("november", "nov", "নভেম্বর"),
    ("december", "dec", "ডিসেম্বর"),
)
MONTH_NUMBER = {name: n for n, names in enumerate(MONTHS, 1) for name in names}
MONTH_PATTERN = "|".join(
    re.escape(name)
    for name in sorted(MONTH_NUMBER, key=len, reverse=True)
)


def normalized(value):
    return (
        unicodedata.normalize("NFKC", value or "")
        .translate(DIGITS)
        .casefold()
        .replace("‑", "-")
        .replace("–", "-")
    )


def iso(value):
    try:
        return date.fromisoformat(value) if value else None
    except (ValueError, TypeError):
        return None


def bounds(start, end):
    a, b = iso(start), iso(end)
    return (a or b, b or a)


def quoted_dates(text):
    """Only use unambiguous dates that appear in the original quotation."""
    text = normalized(text)
    dates = {
        d
        for raw in re.findall(r"(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)", text)
        if (d := iso(raw))
    }
    for day, month, year in re.findall(
        r"(?<!\d)(\d{1,2})\s+([a-z\u0980-\u09ff]+)\.?\s+(\d{4})(?!\d)", text
    ):
        if month in MONTH_NUMBER and (
            d := iso(f"{year}-{MONTH_NUMBER[month]:02}-{int(day):02}")
        ):
            dates.add(d)
    return dates


def stated_period(text):
    """Infer month bounds only when a month and year are written in the claim."""
    text = normalized(text)
    ranged = re.search(
        rf"\b(?:from\s+)?({MONTH_PATTERN})\s+(?:through|to|until|[-–])\s+"
        rf"({MONTH_PATTERN})\s+(\d{{4}})\b",
        text,
    )
    if ranged:
        first, last, year = ranged.groups()
        start = iso(f"{year}-{MONTH_NUMBER[first]:02}-01")
        month = MONTH_NUMBER[last]
        next_month = date(int(year) + (month == 12), month % 12 + 1, 1)
        return start, date.fromordinal(next_month.toordinal() - 1)
    named = re.search(rf"\b({MONTH_PATTERN})\s+(\d{{4}})\b", text)
    if named:
        month_name, year = named.groups()
        month = MONTH_NUMBER[month_name]
        start = iso(f"{year}-{month:02}-01")
        next_month = date(int(year) + (month == 12), month % 12 + 1, 1)
        return start, date.fromordinal(next_month.toordinal() - 1)
    return None, None


def assessment_type(target):
    """Separate claims about written requirements from claims about events."""
    if target["kind"] == "finding":
        return "finding_closure"
    quote = normalized(target["source"]["quote"])
    requirement = re.compile(
        r"\b(requires?|must|shall|is required to|are required to|"
        r"according to (?:the )?(?:sop|procedure|policy)|"
        r"(?:sop|procedure|policy) (?:states|requires|specifies|instructs))\b"
    )
    if requirement.search(quote):
        return "requirement"
    if re.search(
        r"\b(no|none|without|not (?:reported|recorded|occurred|happened))\b",
        quote,
    ):
        return "absence"
    return "event"


def checked_anchor(choice, chunks, pages, versions):
    chunk = chunks.get(choice.get("chunk_id"))
    quote = choice.get("quote", "").strip()
    if not chunk or len(quote) < 4 or len(quote) > 2600:
        return None
    # Whitespace changes are reversible. Original characters, digits and punctuation must match.
    expr = r"\s+".join(re.escape(s) for s in quote.split())
    matches = list(re.finditer(expr, chunk["text"]))
    if len(matches) != 1:
        return None
    start = chunk["start_at"] + matches[0].start()
    end = chunk["start_at"] + matches[0].end()
    page = pages[chunk["page_id"]]
    boxes = [b["box"] for b in page["blocks"] if b["end"] > start and b["start"] < end]
    if not boxes or page["quality"] != "readable":
        return None
    version = versions[chunk["version_id"]]
    return {
        "version_id": version["id"],
        "extraction_id": version["extraction_id"],
        "page_id": page["id"],
        "page": page["page_no"],
        "chunk_id": chunk["id"],
        "start": start,
        "end": end,
        "quote": page["text"][start:end],
        "boxes": boxes,
        "document": version["title"],
        "revision": version["revision"],
        "method": page["method"],
    }


def passage(chunk, versions):
    v = versions[chunk["version_id"]]
    return {
        "id": chunk["id"],
        "role": v["role"],
        "document": v["title"],
        "page": chunk["page_no"],
        "issued_on": v["issued_on"],
        "period": [v["period_start"], v["period_end"]],
        "issuer": v["issuer"],
        "factory": v["confirmed_factory"],
        "text": chunk["text"],
    }


def literal_scopes(text):
    s = normalized(text)
    return [
        set(re.findall(expr, s))
        for expr in (
            r"\b([a-z]{1,5}-\d{1,5})\b",
            r"\bbuilding\s+([a-z0-9]+)\b",
            r"\bfloor\s+(\d+)\b",
        )
    ]


def finding_reference(quote):
    refs = {
        ref.replace("/", "-")
        for labelled, standard in re.findall(
            r"\bfinding\s+(?:id\s*)?[:#]?\s*([a-z]{1,8}[-/]\d{1,8})\b|\b(fi[-/]\d{1,8})\b",
            normalized(quote),
        )
        if (ref := labelled or standard)
    }
    return next(iter(refs)) if len(refs) == 1 else None


def is_closure_statement(quote):
    """Recognize explicit closure text that the extractor may label as an observation."""
    reference = finding_reference(quote)
    if not reference:
        return False
    text = " ".join(normalized(quote).split())
    if re.search(r"\b(?:not|unresolved|still|remain\w*|again|reopen\w*|recur\w*)\b", text):
        return False
    ref = re.escape(reference).replace(r"\-", "[-/]")
    return bool(re.search(
        rf"\b{ref}\s+(?:was |has been |is )?(?:verified as )?(?:closed|resolved|corrected)\b"
        rf"|\bverified (?:the )?(?:closure|correction) of (?:finding )?{ref}\b",
        text,
    ))


def explicit_open_observations(chunk, issued_on):
    """Recover explicitly labelled observations that the model skipped or paraphrased."""
    labels = re.finditer(
        r"\bfinding\s+(?:id\s*[:#]?\s*)?[a-z]{1,8}[-/]\d{1,8}[ \t]*[:.]\s*[^.\n][^.]{0,480}\.",
        chunk["text"],
        re.IGNORECASE,
    )
    inspection_date = iso(issued_on)
    for match in labels:
        quote = match.group().strip()
        text = normalized(quote)
        dates = quoted_dates(quote)
        if inspection_date and dates and inspection_date not in dates:
            continue
        if is_closure_statement(quote) or re.search(
            r"\b(?:no longer|not|previously)\s+(?:\w+\s+){0,2}(?:blocked|obstructed|open|unsafe)\b"
            r"|\b(?:but now clear|since been cleared)\b",
            text,
        ):
            continue
        if re.search(
            r"\b(?:blocked|obstructed|exposed live wires?|missing guard|still open|remains? open|reopened)\b",
            text,
        ):
            yield {
                "chunk_id": chunk["id"], "quote": quote,
                "kind": "finding", "finding_id": finding_reference(quote), "severity": "unknown",
            }


def finding_scope_conflicts(first, second):
    left_ref, right_ref = finding_reference(first), finding_reference(second)
    if left_ref and right_ref and left_ref != right_ref:
        return True
    scopes = []
    for text, ref in ((first, left_ref), (second, right_ref)):
        assets, buildings, floors = literal_scopes(text)
        assets = {
            asset for asset in assets
            if asset != ref and not asset.startswith(("fi-", "ca-"))
        }
        scopes.append((assets, buildings, floors))
    return any(left and right and left.isdisjoint(right) for left, right in zip(*scopes))


def explicit_closure_anchor(target, chunks, pages, versions):
    """Accept a later inspector's direct, source-cited certification of the same hazard."""
    source = target["source"]
    reference = finding_reference(source["quote"])
    assets = set(literal_scopes(source["quote"])[0]) - {reference}
    if not reference or not assets:
        return None
    original = versions[source["version_id"]]
    for chunk in chunks:
        for sentence in re.findall(r"[^.]{1,650}\.", chunk["text"]):
            quote = sentence.strip()
            text = " ".join(normalized(quote).split())
            if not re.search(
                r"\binspector (?:independently )?(?:verified|confirmed)\b"
                r"|\bindependently verified by (?:the )?inspector\b",
                text,
            ):
                continue
            if (
                finding_reference(quote) != reference or not is_closure_statement(quote)
                or re.search(r"\b(?:report(?:ed|s)?|claim(?:ed|s)?|alleged)\b", text)
                or not assets.intersection(literal_scopes(quote)[0])
                or finding_scope_conflicts(source["quote"], quote)
                or not later_closure_citation(original, versions[chunk["version_id"]], target, quote)
            ):
                continue
            if anchor := checked_anchor({"chunk_id": chunk["id"], "quote": quote}, {chunk["id"]: chunk}, pages, versions):
                return anchor
    return None


def observation_date(source, target):
    dates = (iso(value) for value in (
        source.get("issued_on"), target.get("start_date"), target.get("end_date")
    ))
    return max((value for value in dates if value), default=None)


def later_independent_inspection(source, evidence, target):
    observed = observation_date(source, target)
    issued = iso(evidence.get("issued_on"))
    return bool(
        observed and issued and issued > observed
        and evidence["role"] == "inspection" and evidence["issuer"] == "external"
        and normalized(evidence.get("confirmed_factory"))
        == normalized(source.get("confirmed_factory"))
    )


def later_closure_citation(source, evidence, target, quote):
    if not later_independent_inspection(source, evidence, target):
        return False
    observed = observation_date(source, target)
    issued = iso(evidence["issued_on"])
    dates = quoted_dates(quote)
    return not dates or any(observed < cited <= issued for cited in dates)


def scope_problem(target, verdict, refs, versions, case_period=None):
    if not verdict["compatible"]:
        return "The passages do not establish a common scope."
    source = versions[target["source"]["version_id"]]
    if target.get("facility") and normalized(target["facility"]) != normalized(
        source["confirmed_factory"]
    ):
        return "The extracted facility differs from the confirmed case facility."
    tsc = literal_scopes(
        " ".join(
            [
                target["source"]["quote"],
                target.get("asset") or "",
                target.get("location") or "",
            ]
        )
    )
    for ref in refs:
        esc = literal_scopes(ref["quote"])
        conflict = (
            finding_scope_conflicts(target["source"]["quote"], ref["quote"])
            if target["kind"] == "finding"
            else any(a and b and not (a & b) for a, b in zip(tsc, esc))
        )
        if conflict:
            return (
                "The cited subject or location differs from the inspection statement."
            )
        if normalized(ref["quote"]) == normalized(target["source"]["quote"]):
            return "The second document repeats the statement without independent evidence."
        if (
            versions[ref["version_id"]]["role"] in {"sop", "cap"}
            and assessment_type(target) != "requirement"
        ):
            return "A written plan or procedure does not establish that work happened."
    if target["kind"] == "finding":
        if not all(
            later_closure_citation(source, versions[r["version_id"]], target, r["quote"])
            for r in refs
        ):
            return "The supplied passages do not document a later independent verification."
    else:
        if assessment_type(target) == "requirement":
            # A requirement claim is about what the written rule says, not when
            # the rule was issued or whether the activity was later performed.
            return None
        stated_start, stated_end = stated_period(target["source"]["quote"])
        if target.get("start_date") or target.get("end_date"):
            a, b = bounds(target.get("start_date"), target.get("end_date"))
        elif stated_start or stated_end:
            a, b = stated_start, stated_end
        elif case_period and re.search(r"\b(?:reporting|coverage|review)\s+period\b", normalized(target["source"]["quote"])):
            a, b = bounds(case_period.get("period_start"), case_period.get("period_end"))
        else:
            a, b = bounds(source["period_start"], source["period_end"])
        c, d = bounds(verdict.get("evidence_start"), verdict.get("evidence_end"))
        if c is None and len({r["version_id"] for r in refs}) == 1:
            doc = versions[refs[0]["version_id"]]
            c, d = bounds(doc["period_start"], doc["period_end"])
        cited_dates = {when for ref in refs for when in quoted_dates(ref["quote"])}
        if a and b and cited_dates and all(not a <= when <= b for when in cited_dates):
            return "The dates in the cited quotation fall outside the inspection statement's reporting period."
        if verdict["label"] == "contradicts" and not all((a, b, c, d)):
            return "A common reporting period could not be established."
        if a and c and (a > d or c > b):
            return "These sources describe different time periods."
    return None


async def verify_one(
    target,
    initial,
    all_other,
    versions,
    pages,
    ask,
    *,
    unreadable,
    retrieval_ids,
    case_period=None,
):
    inventory = [
        {
            "version_id": v["id"],
            "document": v["title"],
            "role": v["role"],
            "pages": v["page_count"],
            "readable": v["readable_pages"],
        }
        for v in versions.values()
        if v["id"] != target["source"]["version_id"]
    ]
    coverage = {
        "documents": inventory,
        "retrieved": retrieval_ids,
        "full_search": False,
        "examined_chunks": [],
        "unreadable_pages": unreadable,
    }
    checks = {"secondary": "not_run", "scope": "unchecked"}

    def result(outcome, reason, refs=()):
        return {
            "claim": target,
            "outcome": outcome,
            "reason": reason,
            "evidence": list(refs),
            "coverage": coverage,
            "checks": checks,
        }

    hypothesis = {
        "statement": target["source"]["quote"],
        "kind": target["kind"],
        "assessment_type": assessment_type(target),
        "scope": {
            k: target.get(k)
            for k in ("asset", "facility", "location", "start_date", "end_date")
        },
        "source": versions[target["source"]["version_id"]],
    }
    if target["kind"] == "finding":
        hypothesis["question"] = (
            "Do later records document independent verification that this specific finding was corrected?"
        )
        source = versions[target["source"]["version_id"]]
        closure_versions = {
            version_id for version_id, version in versions.items()
            if later_independent_inspection(source, version, target)
        }
        initial = [c for c in initial if c["version_id"] in closure_versions]
        all_other = [c for c in all_other if c["version_id"] in closure_versions]
        unreadable = sum(
            versions[vid]["page_count"] - versions[vid]["readable_pages"]
            for vid in closure_versions
        )
        coverage["unreadable_pages"] = unreadable
        coverage["retrieved"] = [c["id"] for c in initial if c["id"] in retrieval_ids]
        if not closure_versions:
            coverage["full_search"] = True
            return result(
                "unresolved",
                "No later independent inspection was selected. Factory corrective-action records cannot establish closure.",
            )
        if closure := explicit_closure_anchor(target, all_other, pages, versions):
            checks["scope"] = "compatible"
            checks["closure"] = "explicit_independent_inspection"
            coverage["examined_chunks"] = [closure["chunk_id"]]
            return result(
                "supported",
                "A later independent inspection explicitly verified correction of this finding at the same asset.",
                [closure],
            )

    async def evaluate(candidates):
        coverage["examined_chunks"] = [c["id"] for c in candidates]
        return await ask(
            VERIFY,
            {
                "target": hypothesis,
                "sources": [passage(c, versions) for c in candidates],
            },
            Verdict,
        )

    candidates = initial
    verdict = await evaluate(candidates)
    if verdict["label"] == "insufficient":
        if unreadable:
            return result(
                "not_assessed",
                "The selected documents contain unreadable or uncertain pages. Review those pages before concluding evidence is missing.",
            )
        if sum(len(c["text"]) for c in all_other) > ABSENCE_LIMIT:
            return result(
                "not_assessed",
                "The available evidence exceeds the complete secondary-search budget.",
            )
        coverage["full_search"] = True
        if {c["id"] for c in initial} != {c["id"] for c in all_other}:
            candidates = all_other
            verdict = await evaluate(candidates)
    elif assessment_type(target) == "absence" and not coverage["full_search"]:
        # Negative claims need an exhaustive search: one matching passage does
        # not show that another selected record contains a contrary event.
        if unreadable:
            return result(
                "not_assessed",
                "Some selected pages could not be read, so the absence claim cannot be checked completely.",
            )
        if sum(len(c["text"]) for c in all_other) > ABSENCE_LIMIT:
            return result(
                "not_assessed",
                "The selected records are too large for a complete check of this absence claim.",
            )
        coverage["full_search"] = True
        candidates = all_other
        verdict = await evaluate(candidates)
    allowed = {c["id"]: c for c in candidates}
    refs = []
    for selected in verdict["evidence"]:
        ref = checked_anchor(selected, allowed, pages, versions)
        if not ref:
            return result(
                "needs_review",
                "A proposed evidence quotation could not be located exactly on the cited page.",
            )
        refs.append(ref)
    if verdict["label"] == "ambiguous":
        return result("needs_review", verdict["reason"], refs)
    if verdict["label"] != "insufficient":
        if not refs:
            return result(
                "needs_review",
                "The verifier supplied no traceable evidence for this conclusion.",
            )
        issue = scope_problem(target, verdict, refs, versions, case_period)
        if issue:
            return result("needs_review", issue, refs)
        checks["scope"] = "compatible"
    elif not coverage["full_search"]:
        return result(
            "not_assessed",
            "The available records were not fully examined for missing evidence.",
        )
    premises = (
        [{"text": r["quote"], "document": versions[r["version_id"]]} for r in refs]
        if verdict["label"] != "insufficient"
        else [passage(c, versions) for c in candidates]
    )
    second = await ask(
        BLIND, {"hypothesis": hypothesis, "premises": premises}, SecondOpinion
    )
    checks["secondary"] = second["relation"]
    expected = {
        "supports": "entails",
        "contradicts": "contradicts",
        "insufficient": "insufficient",
    }[verdict["label"]]
    if expected != second["relation"]:
        return result("needs_review", "The two verification passes disagree.", refs)
    if verdict["label"] == "supports":
        return result("supported", verdict["reason"], refs)
    if verdict["label"] == "contradicts" and target["kind"] == "claim":
        return result("contradicted", verdict["reason"], refs)
    if target["kind"] == "finding":
        return result(
            "unresolved",
            "The selected records do not establish independently documented closure of this finding.",
            refs,
        )
    return result(
        "unsupported",
        "The selected records do not fully substantiate this claim.",
        refs,
    )


async def run_verification(db, ai, job, run, step):
    manifest = run["manifest"]
    case_period = await db.one(
        "cases", job["case_id"], fields="period_start,period_end"
    )
    versions = {v["id"]: v for v in manifest}
    # Version IDs are globally unique. A follow-up run may include versions
    # from earlier cases in the same inspection series, so filtering these
    # source rows by the current case would silently drop their evidence.
    query = {"version_id": "in.(" + ",".join(versions) + ")"}
    pages = {p["id"]: p for p in await db.rows("pages", filters=query)}
    chunks = await db.rows(
        "chunks",
        fields="id,version_id,page_id,page_no,start_at,end_at,text,embedding_model",
        filters=query,
        order="version_id,page_no,start_at",
    )

    async def cached(key_parts, callback):
        key = digest([run["config"], key_parts])
        prev = await db.rows(
            "analysis_cache",
            fields="value",
            filters={"case_id": "eq." + job["case_id"], "key": "eq." + key},
        )
        if prev:
            return prev[0]["value"]
        output, usage = await callback()
        await step("usage", usage)
        await step("cache", {"key": key, "value": output})
        return output

    async def ask(prompt, data, schema):
        return await cached(
            [prompt, data, schema.model_json_schema()],
            lambda: ai.structured(prompt, data, schema),
        )

    new = [c for c in chunks if c.get("embedding_model") != run["config"]["embedding"]]
    for i in range(0, len(new), 12):
        group = new[i : i + 12]
        await step(
            "progress",
            {"stage": "Indexing evidence passages", "completed": i, "total": len(new)},
        )
        vec, usage = await ai.embed([c["text"] for c in group], "RETRIEVAL_DOCUMENT")
        await step("usage", usage)
        await step(
            "embeddings",
            {
                "model": run["config"]["embedding"],
                "rows": [{"id": c["id"], "vector": v} for c, v in zip(group, vec)],
            },
        )
    targets = {}
    rejected = 0
    for version in manifest:
        if version["role"] != "inspection":
            continue
        source = [c for c in chunks if c["version_id"] == version["id"]]
        for i in range(0, len(source), 5):
            group = source[i : i + 5]
            await step(
                "progress",
                {
                    "stage": "Extracting inspection statements",
                    "completed": i,
                    "total": len(source),
                },
            )
            extracted = await ask(
                EXTRACT, {"passages": [passage(c, versions) for c in group]}, TargetList
            )
            source_chunks = {c["id"]: c for c in group}
            observations = []
            fallback = [
                item for chunk in group
                for item in explicit_open_observations(chunk, version.get("issued_on"))
            ]
            for item in [*extracted["items"], *fallback]:
                ref = checked_anchor(item, source_chunks, pages, versions)
                if not ref:
                    rejected += 1
                    continue
                if item["kind"] == "finding" and is_closure_statement(ref["quote"]):
                    continue
                if item["kind"] == "finding":
                    reference = finding_reference(ref["quote"])
                    if reference and any(
                        old_id == reference and old["page_id"] == ref["page_id"]
                        and old["start"] < ref["end"] and old["end"] > ref["start"]
                        for old_id, old in observations
                    ):
                        continue
                    if reference:
                        observations.append((reference, ref))
                rid = str(
                    uuid5(
                        UUID(run["id"]),
                        f"{ref['page_id']}/{ref['start']}/{ref['end']}/{item['kind']}",
                    )
                )
                targets[rid] = {**item, "source": ref}
    previous = {
        r["id"]
        for r in await db.rows(
            "results", fields="id", filters={"run_id": "eq." + run["id"]}
        )
    }
    limited = sum(v["page_count"] - v["readable_pages"] for v in manifest)
    for i, (rid, target) in enumerate(targets.items()):
        await step(
            "progress",
            {
                "stage": "Checking claims against other documents",
                "completed": i,
                "total": len(targets),
            },
        )
        if rid in previous:
            continue
        other = [c for c in chunks if c["version_id"] != target["source"]["version_id"]]
        eligible = [v for v in versions if v != target["source"]["version_id"]]
        text = target["source"]["quote"]
        vec = await cached(["query", text], lambda: ai.embed([text], "RETRIEVAL_QUERY"))
        hits = await db.rpc(
            "search",
            cid=job["case_id"],
            vid_list=eligible,
            query_text=normalized(text),
            query_embedding=vec[0],
            model_name=run["config"]["embedding"],
        )
        retrieved = [row["chunk_id"] for row in hits]
        # Nearby lines stay together during chunking. Include immediately adjacent chunks on a retrieved page.
        selected = set(retrieved)
        for j, c in enumerate(other):
            if c["id"] in retrieved:
                for k in (j - 1, j + 1):
                    if 0 <= k < len(other) and other[k]["page_id"] == c["page_id"]:
                        selected.add(other[k]["id"])
        assessment = await verify_one(
            target,
            [c for c in other if c["id"] in selected],
            other,
            versions,
            pages,
            ask,
            unreadable=limited,
            retrieval_ids=retrieved,
            case_period=case_period,
        )
        await step("result", {"id": rid, **assessment})
    if any(version["role"] == "cap" for version in manifest):
        from .cap import analyze_cap

        try:
            cap = await analyze_cap(run, targets, versions, pages, chunks, ask, step)
        except InferenceFailure as exc:
            cap = {
                "actions": [],
                "suggestions": [],
                "coverage": {"complete": False},
                "error": str(exc),
            }
        await db.rpc("cap_publish", jid=job["id"], ticket=job["lease"], analysis=cap)
    await step(
        "finished",
        {
            "partial": bool(limited or rejected or not targets),
            "summary": {
                "claims": len(targets),
                "unanchored_extractions": rejected,
                "uncertain_pages": limited,
            },
        },
    )
