// brand.ts — DeGram shows no "Hermes" name (owner request 2026-10-07, Phase 1301).
//
// The upstream copy names the product "Hermes" in about 700 catalog strings and a few hundred literals. Rather
// than fork every string, the degram variant rebrands at two seams:
//   * the translation catalog (i18n/registry.ts): every string leaf and every message function's result;
//   * the rendered interface (main.tsx): a MutationObserver rewrites text nodes and the visible label attributes
//     (title, aria-label, placeholder, alt) as they appear, which also catches literals outside the catalog.
// Chat messages (user and assistant), editable text and code are never rewritten: they are the user's and the
// model's words, not product chrome. Identifiers (HERMES_HOME) and lowercase commands or paths stay as they are.
// The logo is already DeGram's (components/brand-mark.tsx, F-04).

const BRAND = 'DeGram'
const PATTERN = /\bHermes(?: Agent| Desktop)?\b(?![A-Za-z_])/g

/** `text` with the Hermes product names replaced by DeGram. */
export function rebrandText(text: string): string {
  return text.includes('Hermes') ? text.replace(PATTERN, BRAND) : text
}

/** A copy of a translation tree with every string leaf and every function result rebranded. */
export function rebrandCatalog<T>(value: T): T {
  if (typeof value === 'string') {
    return rebrandText(value) as T
  }

  if (typeof value === 'function') {
    const fn = value as unknown as (...args: unknown[]) => unknown

    return ((...args: unknown[]) => {
      const out = fn(...args)

      return typeof out === 'string' ? rebrandText(out) : out
    }) as T
  }

  if (Array.isArray(value)) {
    return value.map(item => rebrandCatalog(item)) as T
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}

    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = rebrandCatalog(item)
    }

    return out as T
  }

  return value
}

const ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'] as const
/** Text under these is the user's or the model's, never product chrome. */
const PROTECTED = '[data-role="user"], [data-role="assistant"], [contenteditable="true"], textarea, pre, code'

function rebrandElement(element: Element): void {
  for (const name of ATTRIBUTES) {
    const current = element.getAttribute(name)

    if (current && current.includes('Hermes')) {
      element.setAttribute(name, rebrandText(current))
    }
  }
}

function rebrandTextNode(node: Node): void {
  const parent = node.parentElement

  if (parent && !parent.closest(PROTECTED) && node.nodeValue?.includes('Hermes')) {
    node.nodeValue = rebrandText(node.nodeValue)
  }
}

/** Labels are product chrome everywhere; text only outside messages, editable fields and code. */
function rebrandTree(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    rebrandTextNode(node)

    return
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return
  }

  rebrandElement(node as Element)

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)

  for (let child = walker.nextNode(); child; child = walker.nextNode()) {
    if (child.nodeType === Node.TEXT_NODE) {
      rebrandTextNode(child)
    } else {
      rebrandElement(child as Element)
    }
  }
}

/** Rebrand `root` now and every node or label that appears later. Returns the disposer. */
export function startDomRebrand(root: Node = document.body): () => void {
  rebrandTree(root)

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') {
        record.addedNodes.forEach(rebrandTree)
      } else if (record.type === 'characterData') {
        rebrandTree(record.target)
      } else if (record.type === 'attributes' && record.target.nodeType === Node.ELEMENT_NODE) {
        rebrandElement(record.target as Element)
      }
    }
  })

  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES]
  })

  return () => observer.disconnect()
}
