"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { components } from "@/lib/schema";
import { api, type Config, message } from "@/lib/api";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type Profile = components["schemas"]["AccountProfile"];
type AuthState = "loading" | "signed-out" | "authenticated" | "error";

type AuthContextValue = {
  state: AuthState;
  session: Session | null;
  profile: Profile | null;
  client: SupabaseClient | null;
  error: string;
  setSession: (accessToken: string, refreshToken: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>("loading");
  const [session, setSessionState] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [error, setError] = useState("");
  const sessionUserId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    void api<Config>("/v1/config")
      .then(async (config) => {
        if (!active) return;
        const auth = getSupabaseBrowserClient(config);
        setClient(auth);
        const { data, error: sessionError } = await auth.auth.getSession();
        if (sessionError) throw sessionError;
        if (!active) return;
        sessionUserId.current = data.session?.user.id || null;
        setSessionState(data.session);
        setState(data.session ? "loading" : "signed-out");
        const subscription = auth.auth.onAuthStateChange((_event, nextSession) => {
          if (!active) return;
          const nextUserId = nextSession?.user.id || null;
          const userChanged = sessionUserId.current !== nextUserId;
          sessionUserId.current = nextUserId;
          setSessionState(nextSession);
          if (!nextSession) {
            setProfile(null);
            setState("signed-out");
          } else if (userChanged) {
            setProfile(null);
            setState("loading");
          } else {
            // A token refresh for the same account should not unmount the app shell.
            setState((current) => current === "authenticated" ? current : "loading");
          }
        });
        unsubscribe = () => subscription.data.subscription.unsubscribe();
      })
      .catch((caught) => {
        if (!active) return;
        setError(message(caught));
        setState("error");
      });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    const controller = new AbortController();
    setError("");
    void api<Profile>("/v1/me", token, "GET", undefined, controller.signal)
      .then((nextProfile) => {
        setProfile(nextProfile);
        setState("authenticated");
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError(message(caught));
        setState("error");
      });
    return () => controller.abort();
  }, [session?.access_token]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      session,
      profile,
      client,
      error,
      setSession: async (accessToken, refreshToken) => {
        if (!client) throw new Error("Authentication is still loading.");
        const { error: sessionError } = await client.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (sessionError) throw sessionError;
      },
      signOut: async () => {
        await client?.auth.signOut({ scope: "local" });
        setSessionState(null);
        setProfile(null);
        setState("signed-out");
      },
    }),
    [client, error, profile, session, state],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
