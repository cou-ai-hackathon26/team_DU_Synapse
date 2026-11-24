import { LoginScreen } from "@/components/v2/login-screen";
import { Suspense } from "react";

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="v2-page login-loading">Preparing secure sign-in…</main>}>
      <LoginScreen />
    </Suspense>
  );
}
