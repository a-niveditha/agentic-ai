"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, BookOpen, ChevronRight, CircleHelp, LogOut, Menu, MessageSquareText, X } from "lucide-react";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button, cx } from "@/components/ui";

const links = [
  { href: "/chat", label: "Conversations", icon: MessageSquareText },
  { href: "/knowledge", label: "Knowledge base", icon: BookOpen },
  { href: "/ask", label: "Ask your library", icon: CircleHelp },
  { href: "/status", label: "System status", icon: Activity },
];

function SideNavigation({ close }: { close?: () => void }) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const router = useRouter();
  return (
    <div className="flex h-full flex-col">
      <Link href="/chat" onClick={close} className="mb-10 flex items-center gap-3 px-2">
        <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-moss text-lg font-semibold text-white">F</span>
        <span><span className="block text-sm font-semibold tracking-tight text-ink">Fieldnote</span><span className="text-xs text-muted">AI workspace</span></span>
      </Link>
      <p className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[#97a099]">Workspace</p>
      <nav className="space-y-1">
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return <Link key={href} href={href} onClick={close} className={cx("flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition", active ? "bg-mint text-moss" : "text-[#66736b] hover:bg-[#f3f5f1] hover:text-ink")}><Icon size={18} strokeWidth={1.8} />{label}{active && <ChevronRight className="ml-auto" size={15} />}</Link>;
        })}
      </nav>
      <div className="mt-auto border-t border-line pt-5">
        <div className="mb-4 flex items-center gap-3 px-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#e9eee8] text-sm font-semibold text-[#526258]">{user?.name?.slice(0, 1).toUpperCase() || "U"}</span>
          <div className="min-w-0"><p className="truncate text-sm font-medium text-ink">{user?.name}</p><p className="truncate text-xs text-muted">{user?.email}</p></div>
        </div>
        <button onClick={() => { signOut(); router.replace("/login"); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted hover:bg-red-50 hover:text-red-700"><LogOut size={17} />Sign out</button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { status, retry } = useAuth();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (status === "signed-out") router.replace("/login");
  }, [status, router]);

  if (status === "loading") return <div className="grid min-h-screen place-items-center text-sm text-muted">Restoring your workspace…</div>;
  if (status === "error") return <main className="grid min-h-screen place-items-center p-6"><div className="max-w-sm space-y-4 text-center"><h1 className="text-xl font-semibold">Can’t connect to your workspace</h1><p className="text-sm leading-6 text-muted">Your sign-in is saved. Check that the server is running, then try again.</p><Button onClick={() => void retry()}>Try again</Button></div></main>;
  if (status !== "signed-in") return null;

  return (
    <div className="min-h-screen bg-canvas lg:flex">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[252px] border-r border-line bg-white px-5 py-7 lg:block"><SideNavigation /></aside>
      <div className="min-w-0 flex-1 lg:pl-[252px]">
        <header className="sticky top-0 z-10 flex h-[68px] items-center justify-between border-b border-line bg-white/90 px-5 backdrop-blur lg:hidden">
          <Link href="/chat" className="flex items-center gap-2 font-semibold"><span className="grid h-8 w-8 place-items-center rounded-xl bg-moss text-white">F</span>Fieldnote</Link>
          <button aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen(!menuOpen)} className="rounded-lg p-2 text-muted hover:bg-[#f1f4ef]">{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
        </header>
        {menuOpen && <div className="fixed inset-0 z-30 bg-ink/20 lg:hidden" onClick={() => setMenuOpen(false)}><aside className="h-full w-[290px] bg-white p-5 py-7 shadow-soft" onClick={(e) => e.stopPropagation()}><SideNavigation close={() => setMenuOpen(false)} /></aside></div>}
        <main className="mx-auto min-h-[calc(100vh-68px)] max-w-[1440px] p-4 sm:p-7 lg:min-h-screen lg:p-10">{children}</main>
      </div>
    </div>
  );
}
