import Link from "next/link";

export function AuthPanel({
  title,
  description,
  alternate,
  children,
}: {
  title: string;
  description: string;
  alternate: { prompt: string; label: string; href: string };
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f2f5f0] px-5 py-12">
      <section className="w-full max-w-[440px] rounded-[28px] border border-line bg-white p-7 shadow-soft sm:p-10">
        <Link href="/" className="mb-10 inline-flex items-center gap-2 font-semibold tracking-tight text-ink">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-mint text-moss">F</span>
          Fieldnote
        </Link>
        <div className="mb-8">
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-moss">Your AI workspace</p>
          <h1 className="text-3xl font-semibold tracking-tight text-ink">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-muted">{description}</p>
        </div>
        {children}
        <p className="mt-7 text-center text-sm text-muted">
          {alternate.prompt}{" "}
          <Link href={alternate.href} className="font-semibold text-moss hover:underline">{alternate.label}</Link>
        </p>
      </section>
    </main>
  );
}
