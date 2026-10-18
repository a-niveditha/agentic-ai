"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button } from "@/components/ui";

export default function HomePage() {
  const { status, retry } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "signed-in") router.replace("/chat");
    if (status === "signed-out") router.replace("/login");
  }, [status, router]);
  if (status === "error") return <main className="grid min-h-screen place-items-center p-6"><div className="max-w-sm text-center"><p className="mb-4 text-sm text-muted">Could not restore your saved sign-in. Check the server connection and try again.</p><Button onClick={() => void retry()}>Try again</Button></div></main>;
  return <div className="grid min-h-screen place-items-center text-sm text-muted">Opening your workspace…</div>;
}
