"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/apiClient";
import { Button, Field, Input, Notice } from "@/components/ui";
import { AuthPanel } from "./AuthPanel";
import { useAuth } from "./AuthProvider";

export function LoginForm() {
  const { login, status } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (status === "signed-in") router.replace("/chat");
  }, [status, router]);

  return (
    <AuthPanel title="Welcome back" description="Sign in to continue your conversations and pick up where you left off." alternate={{ prompt: "New to Fieldnote?", label: "Create an account", href: "/signup" }}>
      <form className="space-y-5" onSubmit={submit}>
        {error && <Notice>{error}</Notice>}
        <Field label="Email address"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button className="w-full py-3" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
    </AuthPanel>
  );
}
