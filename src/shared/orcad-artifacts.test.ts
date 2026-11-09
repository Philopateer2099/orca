import { describe, expect, it } from 'vitest'
import { ORCAD_MOBILE_WEB_MANIFEST, orcadMobileWebAssetFilenames } from './orcad-artifacts'

describe('standalone runtime artifacts', () => {
  it.each([
    ['no assets', { assets: [] }],
    ['a traversal path', { assets: [{ path: '../orcad.js' }] }],
    ['an absolute path', { assets: [{ path: '/etc/passwd' }] }],
    ['a backslash path', { assets: [{ path: 'a\\b.js' }] }],
    ['a missing path', { assets: [{}] }]
  ])('refuses a page manifest with %s', (_label, manifest) => {
    expect(() => orcadMobileWebAssetFilenames(JSON.stringify(manifest))).toThrow(
      ORCAD_MOBILE_WEB_MANIFEST
    )
  })

  it('ships the host-only language catalogs with the page assets', () => {
    const manifest = {
      assets: [{ path: 'index.html' }],
      catalogs: [{ locale: 'de', path: 'catalogs/de.json' }]
    }

    expect(orcadMobileWebAssetFilenames(JSON.stringify(manifest))).toEqual([
      'out/mobile-web/catalogs/de.json',
      'out/mobile-web/index.html'
    ])
  })
})
