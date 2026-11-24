# SafetyProof AI

SafetyProof AI cross-checks garment factory inspection reports against supporting records. The reviewer can compare English and Bangla evidence, open the exact PDF page behind a result, and keep a record of their decision.

Live app: https://safetyproof.vercel.app · API: https://safetyproof-api.vercel.app/docs

## Local setup

Requires Python 3.12, Node 22 and npm. Local development uses the same hosted Supabase project as Vercel; there is no separate local database. Run from the repository root.

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements-dev.lock
npm --prefix frontend ci

mkdir -p .local/tessdata
for lang in eng ben; do
  curl -fsS "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/$lang.traineddata" -o ".local/tessdata/$lang.traineddata"
done
```

Set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in the root `.env` from the **SafetyProof AI** project in Supabase. Add `GEMINI_API_KEY` there too. The root `.env` is ignored by Git; keep it private. Local and Vercel sessions use the same accounts, cases and documents. Choose **Sign in as Reviewer / Auditor** and sign in with an active reviewer account. The document library is available after sign-in.

For scheduled reviewer uploads, the configured `GEMINI_API_KEY` also powers a content screen after OCR. Gemini checks whether the readable text is substantively an inspection report; it does not authenticate the report or verify that its claims are true. A clear mismatch, ambiguous content, or provider failure blocks the upload with a reason. If OCR cannot read the PDF, the reviewer can enter metadata manually and continue. The key stays in the backend `.env` and is never sent to the browser. Without a Gemini key, the app falls back to its basic OCR document-role check.

Add a free-tier project key as `GEMINI_API_KEY` in the root `.env`. Before starting the backend, check generation and embeddings with `PYTHONPATH=backend python scripts/check_models.py`. Set `MIN_REQUEST_INTERVAL` according to the project's quota.

Structured extraction and verification can instead use xAI's Responses API by setting `LLM_PROVIDER=xai`, `XAI_API_KEY` and `XAI_MODEL=grok-4.7`. The retrieval index still uses `GEMINI_API_KEYS` with `gemini-embedding-001`; changing embedding providers requires rebuilding stored vectors. Compare the two structured providers on the same synthetic follow-up cases with `PYTHONPATH=backend .venv/bin/python scripts/compare_providers.py`.

Start the complete local application from the repository root with one command:

```bash
./scripts/dev-local.sh
```

The launcher validates Node and Python, safely reuses private configuration and installed dependencies from another SafetyProof worktree when needed, verifies the API and hosted Supabase Auth, and starts only the missing services. It inspects every IPv4 and IPv6 listener on port 3000, replaces stale SafetyProof frontends only after verifying their repository, and confirms that both localhost hostnames serve the V2 routes. Logs are written to `.local/dev/` and remain untracked.

For manual troubleshooting, the equivalent service commands are:

```bash
PYTHONPATH=backend .venv/bin/uvicorn safetyproof.main:app --host 127.0.0.1 --port 8000
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 npm --prefix frontend run dev -- --webpack --hostname 127.0.0.1 --port 3000
```

Open **http://127.0.0.1:3000** or **http://localhost:3000**; both are verified against the same V2 frontend. This local UI and API write to the hosted Supabase project, so their changes are visible from Vercel and other devices. Restart the launcher after editing environment variables. API documentation is available at **http://127.0.0.1:8000/docs**.

## How verification works

FastAPI stores private originals in Supabase Storage and extracts page-bound text. Printed scans use Tesseract with English and Bangla language data. Large PDFs are processed in batches with resumable progress and no fixed page-count limit. File size follows the Supabase Storage project quota. Gemini extracts structured assertions and findings from inspection reports. Supabase pgvector ranks candidate passages together with lexical and asset identifier matching. Gemini then verifies the retrieved evidence. A separate blind natural-language inference prompt uses the same model and sends disagreements to review. The application validates exact source quotations, applies scope checks and records the documents examined before publishing results.

The three review flags are contradiction, unsupported claim and missing documented closure. Unreadable pages and incomplete searches can prevent an assessment. The reviewer can accept or dismiss a flag, request evidence, or add a note. Decisions apply to their analysis run. **Overview** brings pending flags and evidence requests together. Requests remain open across later runs until a reviewer changes the decision on the original assessment. **Run history** compares selected document revisions and exact source-matched outcomes. Formal closure and physical safety assessments remain the responsibility of the appropriate inspection authority.

Upload a Corrective Action Plan using the **CAP** document role and include it in a run. **CAP matching** shows source-cited actions and suggests links from explicit finding references or shared asset identifiers. A reviewer may confirm, dismiss, or manually add a link. Each decision belongs to its snapshot.

## Accounts and factory access

The account migration adds eight fictional factories with Bangladeshi place names. Existing cases and test accounts are carried forward into the hosted Supabase project. Login credentials are managed by Supabase Auth; pending accounts need an admin-issued invite before they can set a password.

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your shell or private environment, then run:

```bash
PYTHONPATH=backend .venv/bin/python scripts/seed_accounts.py --demo-reviewers
```

The seed can be rerun. It provisions the env-configured admin without resetting the password of an existing admin. The optional flag creates three fictional pending reviewers with different factory assignments. They have no passwords or pre-issued links. Use **Resend invite** to issue the first link. Set `APP_URL` to the frontend origin for invite links, for example `http://localhost:3000` for local development. Keep public Supabase Auth sign-ups disabled. The app submits manager and reviewer applications using its own controlled endpoints.

- **Admin** sees factory conditions, case assessments and corrective task status. From **Reviewers**, create a reviewer and copy a one-time invite link. Use **Factory assignments** to choose the reviewer and save their factory access separately. The reviewer sets a password on `/set-password`. Invitations expire after 48 hours and resending invalidates the previous link. The app sends no email. Admins can deactivate accounts and cannot start a verification run.
- **Scheduled cases** start in **Admin → Factories → New case**. The admin chooses a factory, an active reviewer assigned to it, and an inspection date. The case appears in the reviewer’s workspace and the manager gets an in-app notice showing the date and reviewer organization. The reviewer uploads the inspection PDF with a readable labelled inspection date near the start. It must match the scheduled inspection date. Once the report is ready, the manager can open it and submit the CAP, incident records, or other factory evidence from **Documents**. The reviewer runs verification, matches CAP actions and assigns corrective work in that case.
- **Documentary follow-ups** start from **Request follow-up** on the preceding inspection. In the new case, run verification on the preceding report and its factory evidence. Save notes and decisions on flags, then choose **Prepare follow-up report** in **Review queue**. Save the report as PDF in the print dialog and upload it in the new case’s **Documents** tab. The manager can then submit another CAP and evidence. Subsequent reviews carry forward the finding IDs and distinguish documentary carry-forward from a hazard physically observed again.
- **Reviewer access requests** start from **Request reviewer access** on the sign-in page. An admin approves or rejects the request in **Reviewers**. Approval creates an invite for the admin to share manually. The password setup page displays the fixed account email. Both reviewer forms use the same organization list and fictional `.test` domains. **Other** accepts a custom organization and email address.
- **Factory Manager** chooses **Apply as a Factory Manager** on the login screen. The application needs an existing factory, contact details, an office ID and a password. Admins can confirm or change the factory and approve, or reject with a reason. The applicant checks the decision by signing in with the same credentials. Approval limits the account to one factory. Managers can track assigned corrective tasks, comment, start work and submit new evidence PDFs. The reviewer can accept evidence, return it for revision or add it to verification.
- **Office ID** files go to the private `manager-id-cards` bucket. Only an authenticated admin can retrieve a pending application's validated file. Decisions delete the stored card and stamp the deletion date. If storage is temporarily unavailable, the admin can retry the deletion from the application detail. Login, invitation setup and signup have database-backed rate limits.

See [the architecture brief](docs/architecture-brief.md) for entry points, permissions and job flow.

## Verification and evaluation

```bash
PYTHONPATH=backend .venv/bin/pytest -q backend/tests
npm --prefix frontend run build
.venv/bin/python scripts/make_fixtures.py --evaluation
PYTHONPATH=backend .venv/bin/python evaluation/run.py --split held_out --baseline
```

The integration tests use real local Supabase Auth, Postgres and Storage. The existing document workflow test uses scripted inference. The account test covers invite expiry and single-use, role boundaries, status-aware login, factory reassignment and office ID deletion. Run only the account test with `PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_accounts.py`. The evaluation command requires running services and a configured Gemini key and calls the real provider. Results go under `evaluation/output/`. Document fixtures are fictional. Their labels are separate from the application inputs. More details are in [evaluation/README.md](evaluation/README.md).

## Deployment and disclosure

Deploy two Vercel projects from this repository: `frontend` (Next.js) and `backend` (FastAPI). The backend uses Vercel Queues for document processing and bounded, resumable verification jobs. Supabase provides Auth, Postgres and private PDF storage. Configuration and the live demonstration sequence are in the [delivery guide](docs/planning/delivery.md). The Docker service in `render.yaml` remains an optional alternative; run only one worker deployment against a database. Record the public repo, live link, demo video and team member names before submitting. Share test credentials in the organizer's submission form.

- Stack and libraries include [Next.js](https://nextjs.org), React, Tailwind CSS, TanStack Query, Lucide, PDF.js, [FastAPI](https://fastapi.tiangolo.com), [Supabase](https://supabase.com), pgvector, pdfplumber, pypdfium2 and [Tesseract](https://github.com/tesseract-ocr/tesseract). The lock files list exact dependencies.
- AI inference uses Gemini API with `gemini-3.5-flash-lite` and `gemini-embedding-001` by default. Google’s SDK provides access. The application uses no model training.
- DM Sans and Noto Sans Bengali are served locally through Fontsource. The document illustration uses HTML and CSS. Synthetic PDFs are generated with ReportLab and Pillow.
- OpenAI Codex assisted with planning, implementation, debugging and testing. Add other tools if the team uses them.
- All PDFs included here are fictional. Send only synthetic records through the free model API for this prototype.
