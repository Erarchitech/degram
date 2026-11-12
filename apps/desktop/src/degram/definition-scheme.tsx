import type { AdvancedMappingCopy } from './i18n'

export type Line = { points: [number, number][]; label: string }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Closed, finite drawing vocabulary. Reject the ENTIRE packet on any unknown key, coordinate or bound violation;
 * no partial compound, arbitrary SVG, URLs, annotation primitives or measurements cross this boundary. */
export function safeDefinitionScheme(value: unknown): Line[] | null {
  if (!record(value) || Object.keys(value).some(k => k !== 'lines') || !Array.isArray(value.lines) || !value.lines.length || value.lines.length > 128) {
    return null
  }

  const lines: Line[] = []
  let total = 0

  for (const line of value.lines) {
    if (!record(line) || Object.keys(line).some(k => k !== 'points' && k !== 'label') || !Array.isArray(line.points) || line.points.length < 2 || line.points.length > 256 || (line.label !== undefined && (typeof line.label !== 'string' || line.label.length > 120))) {
      return null
    }

    const points: [number, number][] = []

    for (const point of line.points) {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000)) {
        return null
      }

      points.push([point[0], point[1]])
      total++

      if (total > 2048) {
        return null
      }
    }

    lines.push({ points, label: typeof line.label === 'string' ? line.label : '' })
  }

  return lines
}

export function DefinitionScheme({ value, copy }: { value: unknown; copy: AdvancedMappingCopy }) {
  const lines = safeDefinitionScheme(value)

  if (!lines) {
    return <p className="text-xs text-muted-foreground">{copy.noScheme}</p>
  }

  const points = lines.flatMap(line => line.points)
  const xs = points.map(p => p[0])
  const ys = points.map(p => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const width = Math.max(1, Math.max(...xs) - minX)
  const height = Math.max(1, Math.max(...ys) - minY)
  const gutter = Math.max(width, height) * 0.05

  return (
    <figure className="grid min-w-0 gap-1">
      <svg aria-label={copy.scheme} className="max-h-48 w-full text-(--ui-text-secondary)" role="img" viewBox={`${minX - gutter} ${minY - gutter} ${width + 2 * gutter} ${height + 2 * gutter}`}>
        {lines.map((line, i) => <polyline fill="none" key={i} points={line.points.map(p => p.join(',')).join(' ')} stroke="currentColor" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <figcaption className="text-xs text-muted-foreground">{lines.map((line, i) => <span className="block break-words" key={i}>{line.label}</span>)}</figcaption>
    </figure>
  )
}
