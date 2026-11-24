# Evaluation protocol

`labels.json` records 60 targets across six synthetic document families. Three families are reserved for development and three for the held-out split. The records cover the three warning outcomes, supported assertions and ambiguous evidence. Synthetic document authorship and labels are reproducible from `build_labels.py`. They are not independent human annotations.

```bash
.venv/bin/python scripts/make_fixtures.py --evaluation
PYTHONPATH=backend .venv/bin/python evaluation/run.py --split development --limit 5
PYTHONPATH=backend .venv/bin/python evaluation/run.py --split held_out --baseline
```

The evaluation runs real imports and inference against the configured workspace. It uses `ADMIN_EMAIL` and `ADMIN_PASSWORD` to create, assign and clean up cases. It uses the local reviewer account when available, or `EVAL_EMAIL` and `EVAL_PASSWORD` with `EVAL_API_URL`, for uploads and verification. Register the fictional factories named in `labels.json` in the evaluation database and grant the evaluation reviewer access to them under **Factory assignments**. The optional full-bundle baseline classifies an already labelled target in the full document bundle, so it measures verification only. The main pipeline includes extraction and records missed targets. Intermediate metrics are written under `output/`.

Record per-class precision, recall and F1, false flags, citation accuracy, evidence recall at ten, wall time and model usage. Review rejected quotations and abstentions separately. The goal is 90% flag precision, 80% recall per category and 90% relevant evidence recall at ten. No held-out accuracy or latency measurement is published until live runs complete. Review timing with a single participant is exploratory. The test corpus does not cover confidential or real factory records.
