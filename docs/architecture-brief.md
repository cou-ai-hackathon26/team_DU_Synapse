# SafetyProof AI architecture brief

SafetyProof AI checks garment-factory inspection statements and findings against other records, such as incident and drill registers, maintenance logs, corrective action plans (CAPs) and independent follow-up inspections. It reports what the selected documents support and leaves the final assessment to a reviewer.

| Layer | Components |
| --- | --- |
| Web app | Next.js App Router, React, TypeScript, TanStack Query, Tailwind and shared CSS. `frontend/components/workspace.tsx` routes within the signed-in workspace. `admin-workspace.tsx` and `onboarding.tsx` handle account flows. |
| API | FastAPI in `backend/safetyproof/main.py`. `accounts.py` holds account routes. `platform.py` wraps Supabase Auth, PostgREST and Storage. |
| Data | Supabase Auth owns credentials and sessions, with bcrypt password hashes. Postgres stores account profiles, factory assignments, cases, document versions, pages, chunks, runs, reviewer decisions, CAP links, corrective work and application audits. Private Storage holds PDFs and office ID cards in separate buckets. Migrations live in `supabase/migrations`. |
| Processing | `worker.py` processes leased jobs. The local API runs a worker loop. The Vercel backend uses `queue.py` and Vercel Queues. PDF processing uses pdfplumber, pypdfium2 and Tesseract for English and Bangla scans. |
| Verification | `verify.py` extracts claims and findings, retrieves evidence with pgvector and lexical matching, and uses Gemini for structured judgments and a second check. It anchors quotations to PDF pages and checks scope before storing results. `cap.py` extracts actions and suggests finding links. |

Admins use the factory overview to see audit results and create cases for active reviewers assigned to the selected factory. They invite reviewers with one-time 48-hour links, assign reviewer factory access and decide manager applications. Managers are bound to one factory, get matching case memberships and can comment on tasks and submit evidence. Reviewers run verification in the cases assigned to them. Supabase RLS scopes reads to active accounts and case memberships. The FastAPI API resolves the current profile role and status for authenticated requests. Legacy viewer accounts retain read-only case access.

The reviewer uploads document versions, selects records and starts a run. Postgres keeps the selected versions, job state and evidence citations. A finding/action link records what the factory plans to do. Corrective work tracks task progress and independently records the review of submitted evidence. Accepted evidence can be included in a subsequent run. The admin dashboard reads results and task status without changing them.

Local development uses Supabase Docker, FastAPI at port 8000 and Next.js at port 3000. Hosted front and backend use separate Vercel projects; Supabase provides the remote database, authentication and storage. Keep backend service credentials and Gemini keys out of the frontend. `docs/openapi.json` and the generated frontend contract describe the API.
