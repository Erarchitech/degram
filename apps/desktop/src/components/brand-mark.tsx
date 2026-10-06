import { cn } from '@/lib/utils'
import { useTheme } from '@/themes'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// Brand badge: the app-icon tile, theme-aware — light mode shows the black
// mark on the white tile, dark mode the white mark on the #0d1117 tile. The
// mark PNG carries the rounded shape and transparent corners, so no
// tile/rounding classes here. DeGram (Phase 1301): the PNGs keep the upstream
// nous-girl filenames but hold the DeGram halftone-hexagon mark, rendered by
// scripts/generate_degram_icons.py; size via className (default size-14).
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  const { renderedMode } = useTheme()
  const dark = renderedMode === 'dark'

  return (
    <span className={cn('inline-flex size-14 shrink-0 items-center justify-center', className)} {...props}>
      <img alt="" className="size-full object-contain" src={assetPath(dark ? 'nous-girl-dark.png' : 'nous-girl.png')} />
    </span>
  )
}
