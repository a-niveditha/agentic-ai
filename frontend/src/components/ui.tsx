import clsx from "clsx";
import { twMerge } from "tailwind-merge";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

export function cx(...values: Parameters<typeof clsx>) {
  return twMerge(clsx(...values));
}

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const variants = {
    primary: "bg-moss text-white hover:bg-[#235d43] disabled:bg-[#afc8b8]",
    secondary: "border border-line bg-white text-ink hover:bg-[#f4f6f2]",
    ghost: "text-muted hover:bg-[#f0f3ef] hover:text-ink",
    danger: "bg-red-50 text-red-700 hover:bg-red-100",
  };
  return <button className={cx("inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-70", variants[variant], className)} {...props} />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
  return <input ref={ref} {...props} className={cx("w-full rounded-xl border border-line bg-white px-3.5 py-3 text-sm text-ink placeholder:text-[#9aa39c] focus:border-moss focus:outline-none", props.className)} />;
});

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx("w-full resize-y rounded-xl border border-line bg-white px-3.5 py-3 text-sm leading-6 text-ink placeholder:text-[#9aa39c] focus:border-moss focus:outline-none", props.className)} />;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="block space-y-1.5"><span className="block text-sm font-medium text-ink">{label}</span>{children}{hint && <span className="block text-xs text-muted">{hint}</span>}</label>;
}

export function Notice({ children, tone = "error" }: { children: React.ReactNode; tone?: "error" | "info" | "success" }) {
  const styles = {
    error: "border-red-200 bg-red-50 text-red-800",
    info: "border-blue-100 bg-blue-50 text-blue-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };
  return <div role="status" className={cx("rounded-xl border px-4 py-3 text-sm leading-6", styles[tone])}>{children}</div>;
}
