"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { clearToken, getToken, setToken } from "@/lib/apiClient";
import { getCurrentUser, login as loginRequest, signup as signupRequest, type User } from "./authApi";

type AuthStatus = "loading" | "signed-in" | "signed-out" | "error";
type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<void>;
  signOut: () => void;
  retry: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);

  const retry = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setStatus("signed-out");
      return;
    }
    setStatus("loading");
    try {
      setUser(await getCurrentUser());
      setStatus("signed-in");
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        clearToken();
        setUser(null);
        setStatus("signed-out");
      } else {
        setStatus("error");
      }
    }
  }, []);

  useEffect(() => {
    void retry();
    const handleUnauthorized = () => {
      setUser(null);
      setStatus("signed-out");
    };
    window.addEventListener("agentic:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("agentic:unauthorized", handleUnauthorized);
  }, [retry]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await loginRequest(email, password);
    setToken(result.token);
    setUser(result.user);
    setStatus("signed-in");
  }, []);

  const signup = useCallback(async (email: string, password: string, name: string) => {
    const result = await signupRequest(email, password, name);
    setToken(result.token);
    setUser(result.user);
    setStatus("signed-in");
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
    setStatus("signed-out");
  }, []);

  const value = useMemo(() => ({ status, user, login, signup, signOut, retry }), [status, user, login, signup, signOut, retry]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
