# Hazard history test case

The PDFs describe one fictional hazard at Kadam Weaving Works. To use them in the app, create the test factory with that name and assign a reviewer and a factory manager. Schedule the March inspection, then create April, May and June as linked follow-ups in the same series. Set each scheduled date to the date printed in its report.

| Date | Document to upload | Expected history after verification |
| --- | --- | --- |
| 9 March 2026 | `01-march-inspection.pdf` as an external inspection | Opened |
| 12 March 2026 | `02-bangla-corrective-action-plan.pdf` as a factory CAP in the March case | Still Opened. The factory says it cleared the exit. The March assessment remains Missing documented closure. |
| 13 April 2026 | `03-april-follow-up.pdf` as an external inspection | Carried forward |
| 11 May 2026 | `04-may-follow-up.pdf` as an external inspection | Closed after independent verification |
| 8 June 2026 | `05-june-follow-up.pdf` as an external inspection | Reopened |

Run verification in March with the inspection and the CAP. For each follow-up, select the current inspection, the earlier inspections and the Bangla CAP. Open **Hazard history**, choose `FI-26` if prompted, and click the timeline entries to verify their PDF citations. Use a test factory and test accounts because the local app can share data with the hosted app.

Regenerate the PDFs with `python scripts/make_fixtures.py --hazard-history-example`. The backend regression tests use the same files to exercise OCR, closure checks and the hazard timeline.
