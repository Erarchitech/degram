import { afterEach, describe, expect, it } from 'vitest'

import { productMark, rebrandCatalog, rebrandText, startDomRebrand } from './brand'

describe('rebrandText (Phase 1301: no Hermes name in DeGram)', () => {
  it('replaces the product names with DeGram', () => {
    expect(rebrandText('Ask Hermes…')).toBe('Ask DeGram…')
    expect(rebrandText('Hermes Agent is working')).toBe('DeGram is working')
    expect(rebrandText('Hermes Desktop cannot answer x')).toBe('DeGram cannot answer x')
    expect(rebrandText('Hermes (default)')).toBe('DeGram (default)')
    expect(rebrandText('Hermes’s settings')).toBe('DeGram’s settings')
  })

  it('replaces the uppercase wordmarks too', () => {
    expect(rebrandText('HERMES AGENT')).toBe('DEGRAM')
    expect(rebrandText('HERMES')).toBe('DEGRAM')
    expect(rebrandText('HERMES DESKTOP')).toBe('DEGRAM')
    expect(rebrandText('HERMES_HOME and HERMES-WATCH')).toBe('HERMES_HOME and HERMES-WATCH')
  })

  it('leaves identifiers, paths and lowercase commands alone', () => {
    expect(rebrandText('HERMES_HOME')).toBe('HERMES_HOME')
    expect(rebrandText('run `hermes doctor`')).toBe('run `hermes doctor`')
    expect(rebrandText('C:\\Users\\a\\AppData\\Local\\hermes')).toBe('C:\\Users\\a\\AppData\\Local\\hermes')
    expect(rebrandText('Hermesian')).toBe('Hermesian')
  })
})

describe('rebrandCatalog', () => {
  it('rewrites every string leaf and every function result, keeps the shape', () => {
    const catalog = {
      a: 'Open Hermes',
      nested: { b: (n: number) => `Hermes has ${n} tasks`, c: 42, d: ['Hermes', 'x'] }
    }

    const out = rebrandCatalog(catalog) as typeof catalog

    expect(out.a).toBe('Open DeGram')
    expect(out.nested.b(3)).toBe('DeGram has 3 tasks')
    expect(out.nested.c).toBe(42)
    expect(out.nested.d).toEqual(['DeGram', 'x'])
    expect(catalog.a).toBe('Open Hermes')
  })
})

describe('startDomRebrand', () => {
  let stop: (() => void) | null = null

  afterEach(() => {
    stop?.()
    stop = null
    document.body.innerHTML = ''
  })

  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  it('rewrites interface text and labels, now and as nodes appear', async () => {
    document.body.innerHTML =
      '<header><span>Hermes is working</span><button title="Open Hermes" aria-label="Reacted by Hermes"></button>' +
      '<input placeholder="Ask Hermes…" value="Hermes typed by me"></header>'
    stop = startDomRebrand(document.body)

    expect(document.querySelector('span')!.textContent).toBe('DeGram is working')
    expect(document.querySelector('button')!.getAttribute('title')).toBe('Open DeGram')
    expect(document.querySelector('button')!.getAttribute('aria-label')).toBe('Reacted by DeGram')
    expect(document.querySelector('input')!.getAttribute('placeholder')).toBe('Ask DeGram…')
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('Hermes typed by me')

    const late = document.createElement('p')

    late.textContent = 'Could not connect to Hermes gateway'
    document.body.append(late)
    await flush()
    expect(late.textContent).toBe('Could not connect to DeGram gateway')
  })

  it('never touches chat messages, editable text or code', async () => {
    document.body.innerHTML =
      '<div data-role="user"><p>Tell me about Hermes</p></div>' +
      '<div data-role="assistant"><p>Hermes was a Greek god</p></div>' +
      '<textarea>Hermes</textarea><div contenteditable="true">Hermes draft</div>' +
      '<pre><code>import hermes; Hermes()</code></pre>'
    stop = startDomRebrand(document.body)

    const answer = document.createElement('p')

    answer.textContent = 'Hermes, again'
    document.querySelector('[data-role="assistant"]')!.append(answer)
    await flush()

    expect(document.body.textContent).toBe(
      'Tell me about HermesHermes was a Greek godHermes, againHermesHermes draftimport hermes; Hermes()'
    )

    const reaction = document.createElement('button')

    reaction.setAttribute('title', 'Reacted by Hermes')
    document.querySelector('[data-role="assistant"]')!.append(reaction)
    await flush()
    expect(reaction.getAttribute('title')).toBe('Reacted by DeGram')
  })

  it('stops observing when disposed', async () => {
    stop = startDomRebrand(document.body)
    stop()
    stop = null

    const p = document.createElement('p')

    p.textContent = 'Hermes'
    document.body.append(p)
    await flush()
    expect(p.textContent).toBe('Hermes')
  })
})

describe('productMark', () => {
  it('is DEGRAM in variant degram and the upstream mark otherwise', async () => {
    const { $degramEnabled } = await import('@/store/degram-flag')

    $degramEnabled.set(true)
    expect(productMark('HERMES')).toBe('DEGRAM')
    expect(productMark('HERMES AGENT')).toBe('DEGRAM')
    $degramEnabled.set(false)
    expect(productMark('HERMES')).toBe('HERMES')
  })
})
