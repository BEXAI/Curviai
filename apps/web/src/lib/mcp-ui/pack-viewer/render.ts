/**
 * Draws a ViewerView into the viewer's root element (PHASE_19 P19-19). Shipped
 * inside the viewer's HTML like ./state.ts, so it is SELF CONTAINED: it reads
 * only its parameters and the DOM it is handed.
 *
 * Text goes in through textContent only, never innerHTML (O11: structured
 * content is untrusted), so a product title or a refusal line holding markup
 * or a script shows as plain text. Images load only the preview links the
 * state machine kept (curvi.ai, /api/mcp/preview/), and buttons hand only the
 * kept download links to the opener.
 */

import type { ViewerView } from "./state";

export interface ViewerActions {
  /** Open a curvi.ai link outside the viewer. */
  open(url: string): void;
  /** Show every file (fullscreen, or inline when the host has no fullscreen). */
  seeAll(): void;
  /** A preview failed to load. */
  linkFailed(): void;
  refresh(): void;
}

/** Replaces the root's children with the view. Self contained. */
export function renderPackViewer(doc: Document, root: HTMLElement, view: ViewerView, actions: ViewerActions): void {
  const make = (tag: string, className: string | null, text?: string | null): HTMLElement => {
    const node = doc.createElement(tag);
    if (className) {
      node.setAttribute("class", className);
    }
    if (typeof text === "string") {
      node.textContent = text;
    }
    return node;
  };
  const button = (label: string, className: string, onClick: () => void): HTMLElement => {
    const node = make("button", className, label);
    node.setAttribute("type", "button");
    node.addEventListener("click", onClick);
    return node;
  };
  const parts: HTMLElement[] = [];

  if (view.heading !== null || view.product !== null) {
    const header = make("header", "head");
    if (view.heading !== null) {
      header.appendChild(make("h1", "heading", view.heading));
    }
    if (view.product !== null) {
      header.appendChild(make("p", "product", view.product));
    }
    parts.push(header);
  }
  if (view.status !== null) {
    const status = make("p", view.tone === "error" ? "status error" : "status", view.status);
    status.setAttribute("role", view.tone === "error" ? "alert" : "status");
    status.setAttribute("aria-live", view.tone === "error" ? "assertive" : "polite");
    parts.push(status);
  }
  if (view.progress !== null && view.progress.total > 0) {
    const bar = make("div", "bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", view.progressLabel);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(view.progress.total));
    bar.setAttribute("aria-valuenow", String(view.progress.done));
    const fill = make("div", "fill");
    fill.style.width = `${Math.round((100 * view.progress.done) / view.progress.total)}%`;
    bar.appendChild(fill);
    parts.push(bar);
  }
  if (view.layout !== "none" && view.items.length > 0) {
    const list = make("ul", `files ${view.layout}`);
    list.setAttribute("aria-label", view.imagesLabel);
    for (const item of view.items) {
      const entry = make("li", item.kind === "image" ? "file" : "file other");
      if (item.previewUrl !== null) {
        const image = make("img", "preview");
        image.setAttribute("src", item.previewUrl);
        image.setAttribute("alt", item.title);
        image.setAttribute("loading", "lazy");
        image.setAttribute("decoding", "async");
        image.addEventListener("error", () => {
          if (root.contains(image)) actions.linkFailed();
        });
        entry.appendChild(image);
      }
      const caption = make("div", "caption");
      caption.appendChild(make("span", "title", item.title));
      if (item.meta !== null) {
        caption.appendChild(make("span", "meta", item.meta));
      }
      if (item.check !== null) caption.appendChild(make("span", "check", item.check));
      if (item.fidelity !== null) caption.appendChild(make("span", "fidelity", item.fidelity));
      entry.appendChild(caption);
      const url = item.downloadUrl;
      if (url !== null) {
        const download = button(item.downloadLabel, "action", () => actions.open(url));
        download.setAttribute("aria-label", `${item.downloadLabel}: ${item.meta ?? item.title}`);
        entry.appendChild(download);
      }
      list.appendChild(entry);
    }
    parts.push(list);
  }
  if (view.note !== null) {
    parts.push(make("p", "note", view.note));
  }
  if (view.showRefresh || view.seeAll !== null || (view.showOpenButton && view.openInCurvi !== null)) {
    const footer = make("div", "foot");
    if (view.showRefresh) {
      const refresh = button(view.refreshLabel, "refresh", () => actions.refresh());
      refresh.setAttribute("data-action", "refresh");
      if (view.refreshing) refresh.setAttribute("disabled", "");
      footer.appendChild(refresh);
    }
    if (view.seeAll !== null) {
      footer.appendChild(button(view.seeAll, "link", () => actions.seeAll()));
    }
    const pageUrl = view.openInCurvi;
    if (view.showOpenButton && pageUrl !== null) {
      footer.appendChild(button(view.openLabel, "link", () => actions.open(pageUrl)));
    }
    parts.push(footer);
  }

  root.replaceChildren(...parts);
  root.setAttribute("data-layout", view.layout);
  root.setAttribute("aria-busy", String(view.refreshing));
}
