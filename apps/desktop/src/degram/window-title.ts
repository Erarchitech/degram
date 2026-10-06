// Window titles for the DeGram variant (Phase 1301). index.html ships the
// upstream `<title>Hermes</title>`, and Electron retitles the native window
// from the page title once it loads, so the BrowserWindow `title` option alone
// never reaches the taskbar. Setting document.title at boot is the one seam
// that covers every window kind without editing the shared index.html.

const HUD_WINDOW = 'hud'

/** The title a window of this kind should carry, or null to keep index.html's. */
export function productWindowTitle(degram: boolean, win: string | null): string | null {
  const name = degram ? 'DeGram' : 'Hermes'

  if (win === HUD_WINDOW) {
    return `${name} HUD`
  }

  return degram ? name : null
}

export function applyProductWindowTitle(doc: { title: string }, degram: boolean, win: string | null): void {
  const title = productWindowTitle(degram, win)

  if (title !== null) {
    doc.title = title
  }
}
