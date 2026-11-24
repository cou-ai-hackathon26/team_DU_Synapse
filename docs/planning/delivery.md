# Delivery and demonstration

| Milestone | Dependency | Verification |
|---|---|---|
| M0 model access and quota | Gemini project key | Structured generation, blind second check and embedding smoke |
| M1 application and database | Supabase and Next.js/FastAPI | Create isolated cases, upload and retrieve a PDF, persist a review |
| M2 ingestion and recovery | M1 | Digital text, printed Bangla OCR, private storage and leased jobs |
| M3 three verification flags | M1–M2 | Compatible scope, citation and search coverage regression cases |
| M4 reviewer workflow | M3 | Compare sources, review, revisit history and print |
| M5 evaluation | M0–M4 | Held-out metrics, browser regression, peak memory and triplicate demo runs |
| M6 CAP matching | P0 documents and findings | Explicit many-to-many matches, ambiguity and unmatched actions |
| M7 submission | P0, organizer dates and hosting access | Public links, reproducible setup, test login, rehearsal and backup |

Use an isolated Supabase Free project, apply the checked-in migrations with the CLI, disable public signup, and create a confirmed reviewer account in Auth. The service must receive its own secret key. The browser uses the publishable or anon key. Deploy the repository as two Vercel projects, with `backend` and `frontend` as their respective root directories. The backend uses the checked-in FastAPI configuration and discovers its Queue subscriber through `backend/pyproject.toml`. Set backend production environment variables `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `QUEUE_ENABLED=true`, `MIN_REQUEST_INTERVAL` and `CORS_ORIGINS` (the final frontend origin). Set the frontend build-time `NEXT_PUBLIC_API_URL` to the backend HTTPS origin and redeploy the frontend after changing it. Disable the old worker before using the new one. Test a clean build, inspect logs for cold starts or memory pressure, verify that the public URL works in a new browser profile, and keep the local services and fixture PDFs available.

Queue processing runs in slices of at most 230 seconds within the function budget. Completed model responses remain in Postgres; a slice that runs out of time yields its lease and retries through the queue. Retry delivery is safe because only the current lease can commit results. Polling a queued job also republishes its notification with a deduplication key if a notification was lost. Manager uploads use signed URLs directly to Supabase Storage, so file size follows the Storage project quota without routing file bytes through Vercel.

Use the Vercel project logs to inspect API and Queue subscriber failures. Set `QUEUE_ENABLED=false` for local development or the optional Render Docker deployment. Keep service keys on the backend project only.

Engage the application shortly before the demonstration. Reserve a second connection for fallback. Test with a fresh run and show the real processing stage while it runs. Draw attention to the original English inspection statement and the Bangla injury entry. Open both pages, review the missing drill coverage and missing closure, and save a decision. Show measured evaluation results and limitations. Keep a recording of a real run as a labelled backup.

The original rulebook covers permitted coding dates, a public repository and Git history, hourly final commits, registered members, AI and asset disclosures, a live demo, test credentials and submission by the confirmed deadline. The deadline extension was reported by the team. Verify the exact Bangladesh time and submission details with the organizers. Before submission, add the registered team and member names, a project description within 150 words, the public links, disclosures and a recording no longer than three minutes if used. Retain the deployment until results.

| Risk | Mitigation |
|---|---|
| Free quota or model unavailable | Verify with the project key, throttle requests, persist job state and disclose outages |
| Wrong actor, month or scope | Require compatible context and test dates, locations and ambiguous cases |
| OCR errors | Preserve original page, mark transcription quality and abstain where coverage is incomplete |
| Sensitive files | Use fictional files for the demo, private storage and case permissions |
| Schedule uncertainty | Protect time for the complete evaluation and rehearsal |
