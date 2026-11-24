import type { Metadata } from "next";
import { Suspense } from "react";
import Script from "next/script";
import "@fontsource-variable/dm-sans";
import "@fontsource/noto-sans-bengali/400.css";
import "./style.css";
import "./v2.css";
import { ThemeProvider } from "@/components/v2/theme-provider";
import { AuthProvider } from "@/components/v2/auth-provider";
import { UnifiedAppFrame } from "@/components/v2/unified-app-shell";

export const metadata: Metadata = {
  title: "SafetyProof AI · Verifiable evidence",
  description:
    "Cross-checking factory safety reports against their own evidence.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script id="safetyproof-theme-init" strategy="beforeInteractive">
          {`(function(){try{var t=localStorage.getItem('safetyproof-theme');var m=t==='light'||t==='dark'?t:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=m;document.documentElement.style.colorScheme=m}catch(e){document.documentElement.dataset.theme='light'}})();`}
        </Script>
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <Suspense fallback={children}>
              <UnifiedAppFrame>{children}</UnifiedAppFrame>
            </Suspense>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
