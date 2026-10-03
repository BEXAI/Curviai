/**
 * A small stand in for the browser, for the pack viewer's tests: elements
 * that record what the viewer sets (no HTML parser, so nothing a test hands
 * in as text can ever become an element), and a host window that records the
 * messages the viewer posts and delivers the host's answers.
 */

import type { OpenAiGlobals, ViewerWindow } from "./runtime";

type Listener = (event: Record<string, unknown>) => void;
/** A JSON-RPC message the viewer posted, read freely by the tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SentMessage = Record<string, any>;

export class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  private text = "";
  private readonly listeners = new Map<string, Listener[]>();
  readonly styleProps = new Map<string, string>();
  readonly style: Record<string, unknown> & { setProperty(name: string, value: string): void };
  scrollHeight = 240;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    const props = this.styleProps;
    this.style = {
      setProperty(name: string, value: string) {
        props.set(name, value);
      },
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  get textContent(): string {
    return this.children.length > 0 ? this.children.map((child) => child.textContent).join("") : this.text;
  }

  set textContent(value: string) {
    this.children = [];
    this.text = String(value);
  }

  /** The viewer never sets markup; a getter would only hide that. */
  set innerHTML(_value: string) {
    throw new Error("innerHTML was set");
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = [...nodes];
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type });
    }
  }

  /** This element and every descendant, depth first. */
  all(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }

  contains(node: FakeElement): boolean {
    return this.all().includes(node);
  }

  find(predicate: (element: FakeElement) => boolean): FakeElement[] {
    return this.all().filter(predicate);
  }

  byClass(name: string): FakeElement[] {
    return this.find((element) => (element.getAttribute("class") ?? "").split(" ").includes(name));
  }

  byTag(tag: string): FakeElement[] {
    return this.find((element) => element.tagName === tag.toUpperCase());
  }

  buttons(label: string): FakeElement[] {
    return this.byTag("button").filter((element) => element.textContent === label);
  }
}

export class FakeDocument {
  readonly documentElement = new FakeElement("html");
  readonly body = new FakeElement("body");
  readonly root = new FakeElement("main");
  readonly created: FakeElement[] = [];

  createElement(tag: string): FakeElement {
    const element = new FakeElement(tag);
    this.created.push(element);
    return element;
  }

  getElementById(id: string): FakeElement | null {
    return id === "root" ? this.root : null;
  }
}

export interface HostOptions {
  openai?: OpenAiGlobals;
  withOpen?: boolean;
}

/** A window for the viewer and the host side of its bridge. */
export function fakeHost(options: HostOptions = {}) {
  const doc = new FakeDocument();
  const sent: SentMessage[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const parent = {
    postMessage(message: unknown) {
      sent.push(JSON.parse(JSON.stringify(message)) as SentMessage);
    },
  };
  const opened: string[] = [];
  const win = {
    document: doc,
    parent,
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    ...(options.openai ? { openai: options.openai } : {}),
    ...(options.withOpen
      ? {
          open: (url: string) => {
            opened.push(url);
            return null;
          },
        }
      : {}),
  };

  /** Delivers a message as the host (the parent window) or another source. */
  function deliver(data: unknown, source: unknown = parent): void {
    for (const listener of listeners.get("message") ?? []) {
      listener({ source, data });
    }
  }

  /** The requests the viewer sent for a method. */
  function requests(method: string): SentMessage[] {
    return sent.filter((message) => message.method === method && message.id !== undefined);
  }

  /** Answers the newest request for a method. */
  function answer(method: string, result: unknown): void {
    const request = requests(method).at(-1);
    if (!request) {
      throw new Error(`no ${method} request`);
    }
    deliver({ jsonrpc: "2.0", id: request.id, result });
  }

  function listenerCount(type: string): number {
    return listeners.get(type)?.size ?? 0;
  }

  return { win: win as unknown as ViewerWindow, doc, sent, opened, deliver, requests, answer, listenerCount };
}
