"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@curvi/ui";

const PRIMARY = [
  { href: "/app", label: "Dashboard" },
  { href: "/app/new", label: "New pack" },
  { href: "/app/products", label: "Products" },
  { href: "/app/library", label: "Library" },
  { href: "/app/brand", label: "Brand kit" },
];
const MORE = [
  { href: "/app/billing", label: "Billing" },
  { href: "/app/settings", label: "Settings" },
  { href: "/app/settings/connections", label: "Connected apps" },
  { href: "/gallery", label: "Gallery" },
  { href: "/tools/main-image-checker", label: "Free tools" },
  { href: "/help", label: "Help" },
  { href: "/support", label: "Contact us" },
];
export function AppNav({ signedIn = false, operator = false }: { signedIn?: boolean; operator?: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); button.current?.focus(); };
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    Array.from(panel.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []).find((item) => item.getClientRects().length > 0)?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", escape); document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", outside); };
  }, [open]);
  function link(item: { href: string; label: string }, dropdown = false) {
    const active = pathname === item.href || (item.href !== "/app" && pathname.startsWith(`${item.href}/`));
    return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)} className={cn("rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500", dropdown && "block", active ? "bg-ink-100 text-ink-950" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900")}>{item.label}</Link>;
  }
  return <nav aria-label="App" className="relative flex shrink-0 items-center gap-1">
    <div className="hidden items-center md:flex">{PRIMARY.map((item) => link(item))}</div>
    <button ref={button} type="button" aria-expanded={open} aria-controls="app-navigation-menu" onClick={() => setOpen(!open)} className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500"><span className="md:hidden">Menu</span><span className="hidden md:inline">More</span></button>
    {open ? <div id="app-navigation-menu" ref={panel} className="absolute right-0 top-full z-50 mt-2 max-h-[75vh] w-64 overflow-auto rounded-xl border border-ink-200 bg-night p-3 shadow-xl">
      <div className="border-b border-ink-200 pb-2 md:hidden"><p className="px-3 py-2 text-xs font-semibold text-ink-600">Workspace</p>{PRIMARY.map((item) => link(item, true))}</div>
      <div className="pt-2"><p className="px-3 py-2 text-xs font-semibold text-ink-600">Account and help</p>{MORE.map((item) => link(item, true))}{operator ? link({ href: "/app/ops", label: "Operations" }, true) : null}{signedIn ? <form action="/auth/signout" method="post" className="md:hidden"><button className="w-full rounded-lg px-3 py-2 text-left text-sm text-ink-600" type="submit">Sign out</button></form> : null}</div>
    </div> : null}
  </nav>;
}
