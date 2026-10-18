"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/apiClient";
import { Button, Field, Input, Notice } from "@/components/ui";
import { AuthPanel } from "./AuthPanel";
import { useAuth } from "./AuthProvider";

export function SignupForm() {
  const { signup, status } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signup(email, password, name);
      router.replace("/chat");
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
    <AuthPanel title="Make room to think" description="Create an account to chat with your documents and keep your work in one place." alternate={{ prompt: "Already have an account?", label: "Sign in", href: "/login" }}>
      <form className="space-y-5" onSubmit={submit}>
        {error && <Notice>{error}</Notice>}
        <Field label="Your name"><Input autoComplete="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Email address"><Input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password" hint="Use 8–128 characters."><Input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button className="w-full py-3" type="submit" disabled={busy}>{busy ? "Creating account…" : "Create account"}</Button>
      </form>
    </AuthPanel>
  );
}
