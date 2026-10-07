// animated-mark.tsx — the DeGram halftone-hexagon mark, drawn live and breathing, for the hero of a fresh draft
// (owner request 2026-10-07, Phase 1301): it replaces the red DEGRAM lettering of the upstream Wordmark.
//
// Geometry is the icon generator's (scripts/generate_degram_icons.py): a pointy-top hexagon of 91 dots on a
// hexagonal lattice — one centre dot and five rings of 6, 12, 18, 24 and 30 — whose radius shrinks ring by ring.
// The motion is a radial pulse: every ring stretches away from the centre and its dots swell, then both settle,
// with each ring a beat behind the one inside it. A ring moves as one, so the mark keeps its six-fold symmetry at
// every frame. Only `transform` animates (animated-mark.css), and prefers-reduced-motion shows the still mark.

import './animated-mark.css'

import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'

const LATTICE = 36.8436
const RING_RADII = [13.9, 11.82, 10.29, 8.46, 6.65, 4.85] as const

/** Outward travel of a dot at the pulse peak, as a fraction of its distance from the centre. */
const STRETCH = 0.09

/** Dot scale at the pulse peak: the centre swells most, the outer ring least. */
const SWELL_CENTRE = 1.35
const SWELL_STEP = 0.04

type Dot = { x: number; y: number; r: number; ring: number }

function markDots(): Dot[] {
  const rings = RING_RADII.length - 1
  const dx = (LATTICE * Math.sqrt(3)) / 2
  const dots: Dot[] = []

  for (let q = -rings; q <= rings; q++) {
    for (let r = -rings; r <= rings; r++) {
      const ring = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2

      if (ring <= rings) {
        dots.push({ x: q * dx, y: (r + q / 2) * LATTICE, r: RING_RADII[ring], ring })
      }
    }
  }

  return dots
}

const DOTS = markDots()

// Room for the stretched and swollen outer ring, so the pulse never clips at the viewBox edge.
const EXTENT = Math.max(...DOTS.map(d => Math.hypot(d.x, d.y) * (1 + STRETCH) + d.r * SWELL_CENTRE))

export const DEGRAM_MARK_DOT_COUNT = DOTS.length

export function DegramAnimatedMark({ className, label = 'DeGram' }: { className?: string; label?: string }) {
  return (
    <svg
      aria-label={label}
      className={cn('degram-mark', className)}
      data-slot="degram-mark"
      role="img"
      viewBox={`${-EXTENT} ${-EXTENT} ${EXTENT * 2} ${EXTENT * 2}`}
    >
      {DOTS.map(dot => (
        <g
          className="degram-mark__dot"
          key={`${dot.x.toFixed(2)}:${dot.y.toFixed(2)}`}
          style={
            {
              '--ring': dot.ring,
              '--sx': `${(dot.x * STRETCH).toFixed(3)}px`,
              '--sy': `${(dot.y * STRETCH).toFixed(3)}px`,
              '--swell': (SWELL_CENTRE - dot.ring * SWELL_STEP).toFixed(3)
            } as CSSProperties
          }
        >
          <circle cx={dot.x} cy={dot.y} r={dot.r} />
        </g>
      ))}
    </svg>
  )
}
