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
  const panel = useRef<HTMLDialogElement>(null);
  const close = () => {
    panel.current?.close();
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  };
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    const menu = panel.current;
    if (!open || !menu) return;
    const mobile = window.matchMedia("(max-width: 767px)");
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const body = document.body;
    const root = document.documentElement;
    const previousRootStyle = { minHeight: root.style.minHeight, overflow: root.style.overflow };
    const previousStyle = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    const isMobile = mobile.matches;
    if (isMobile) {
      // A top-layer dialog stays opaque above Safari's blurred sticky header.
      // Fixing the body also prevents background scrolling on iOS; preserve
      // the exact position and inline styles for every dismissal path.
      const headerBottom = button.current?.closest("header")?.getBoundingClientRect().bottom
        ?? button.current?.getBoundingClientRect().bottom ?? 56;
      menu.style.setProperty("--app-menu-top", `${headerBottom + 8}px`);
      // Preserve the document's scroll extent while its body is out of flow.
      // Otherwise history saves zero for an entry left with the menu open.
      root.style.minHeight = `${root.scrollHeight}px`;
      root.style.overflow = "hidden";
      body.style.position = "fixed";
      body.style.top = `${-scrollY}px`;
      body.style.left = `${-scrollX}px`;
      body.style.width = "100%";
      body.style.overflow = "hidden";
      menu.showModal();
    } else {
      menu.show();
    }
    let scrollLocked = isMobile;
    const restoreScroll = () => {
      if (!scrollLocked) return;
      scrollLocked = false;
      Object.assign(body.style, previousStyle);
      Object.assign(root.style, previousRootStyle);
      window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
    };
    const visibleControls = () => Array.from(menu.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"))
      .filter((item) => item.getClientRects().length > 0);
    visibleControls().find((item) => item.tagName === "A")?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (isMobile && event.key === "Tab") {
        const controls = visibleControls();
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    const outside = (event: PointerEvent) => {
      if (!isMobile && !menu.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismiss = () => {
      // Release synchronously before the browser/router restores the
      // destination history entry, not later during effect cleanup.
      restoreScroll();
      setOpen(false);
    };
    const breakpoint = () => close();
    document.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("popstate", dismiss);
    mobile.addEventListener("change", breakpoint);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("popstate", dismiss);
      mobile.removeEventListener("change", breakpoint);
      menu.close();
      restoreScroll();
    };
  }, [open]);
  function link(item: { href: string; label: string }, dropdown = false) {
    const active = pathname === item.href || (item.href !== "/app" && pathname.startsWith(`${item.href}/`));
    return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)} className={cn("rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500", dropdown && "flex min-h-11 items-center md:min-h-0", active ? "bg-ink-100 text-ink-950" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900")}>{item.label}</Link>;
  }
  return <nav aria-label="App" data-open={open} className="app-nav relative flex shrink-0 items-center gap-1">
    <div className="hidden items-center md:flex">{PRIMARY.map((item) => link(item))}</div>
    <button ref={button} type="button" aria-expanded={open} aria-controls="app-navigation-menu" aria-haspopup="dialog" onClick={() => setOpen(!open)} className="min-h-11 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500 md:min-h-0"><span className="md:hidden">Menu</span><span className="hidden md:inline">More</span></button>
    {open ? <dialog id="app-navigation-menu" ref={panel} aria-label="App menu" className="app-navigation-panel rounded-xl border border-ink-200 p-2 text-ink-900 shadow-xl"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => {
        // Backdrop clicks target the dialog. Padding clicks inside it must
        // remain harmless, including after scrolling a long menu.
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }}>
      <div className="flex items-center justify-between px-3 md:hidden">
        <p className="text-xs font-semibold text-ink-600">Workspace</p>
        <button type="button" onClick={close} aria-label="Close menu" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-ink-600 hover:bg-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div className="border-b border-ink-200 pb-2 md:hidden">{PRIMARY.map((item) => link(item, true))}</div>
      <div className="pt-2 md:pt-0"><p className="px-3 py-2 text-xs font-semibold text-ink-600">Account and help</p>{MORE.map((item) => link(item, true))}{operator ? link({ href: "/app/ops", label: "Operations" }, true) : null}{signedIn ? <form action="/auth/signout" method="post" className="md:hidden"><button className="min-h-11 w-full rounded-lg px-3 py-2 text-left text-sm text-ink-600 hover:bg-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500" type="submit">Sign out</button></form> : null}</div>
    </dialog> : null}
  </nav>;
}
