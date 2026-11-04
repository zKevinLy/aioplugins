// Small DOM helpers shared by every component.

export function $<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required UI element: ${selector}`);
  return element;
}

export function $$<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document
): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

type Child = Node | string | null | undefined | false;

interface ElementOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
}

/** Creates an element; text is always set as text, never as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child) element.append(child);
  }

  return element;
}

/** Runs `callback` once the DOM is ready (or immediately if it already is). */
export function onReady(callback: () => void): void {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  } else {
    callback();
  }
}
