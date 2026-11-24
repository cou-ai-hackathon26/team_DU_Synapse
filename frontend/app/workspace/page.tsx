import { Suspense } from "react";
import { Workspace } from "@/components/workspace";

export default function WorkspacePage() {
  return (
    <Suspense fallback={<main className="boot">Loading workspace…</main>}>
      <Workspace basePath="/workspace" />
    </Suspense>
  );
}
