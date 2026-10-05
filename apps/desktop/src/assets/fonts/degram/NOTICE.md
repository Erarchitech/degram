# DeGram bundled fonts

Self-hosted so the DeGram variant makes no font network request (Phase 1301-13, T-1301-13-03).
All faces are SIL Open Font License 1.1; the license texts travel with them (`LICENSE-*.txt`).

| Family | Files | Source |
|---|---|---|
| Geist (sans) | `geist-sans-latin-{400,500}-normal.woff2` | latin subset vendored in `ui-v2/src/styles/tokens/fonts` (@fontsource/geist-sans) |
| Geist Mono | `geist-mono-latin-{400,500}-normal.woff2` | latin subset vendored in `ui-v2/src/styles/tokens/fonts` (an older @fontsource/geist-mono build than 5.3.0) |
| Geist Mono | `geist-mono-cyrillic-{400,500}-normal.woff2` | @fontsource/geist-mono 5.3.0 (`npm pack`, files only) |
| Oswald | `oswald-latin-{400,500}-normal.woff2` | latin subset vendored in `ui-v2/src/styles/tokens/fonts` (@fontsource/oswald) |
| Oswald | `oswald-cyrillic-{400,500}-normal.woff2` | @fontsource/oswald 5.3.0 (`npm pack`, files only) |

`@fontsource/geist-sans` 5.3.0 ships no Cyrillic subset: Cyrillic text in the Geist Sans role falls back to
Segoe UI through the font stack of the `degram` theme preset.

SHA-256 of the packages and of the Cyrillic files were verified against `1301-ENV.md` before copying:

| File | SHA-256 |
|---|---|
| fontsource-geist-mono-5.3.0.tgz | 1388ea1cc6f02ba10be011352d0c7cabbc29b59e587eaa9938dc63187b4a9169 |
| fontsource-oswald-5.3.0.tgz | 27bf46420288bb65bd186638cde54686aa8f9d5dc975b1d597dfe81a7dd472cb |
| fontsource-geist-sans-5.3.0.tgz (LICENSE only) | 83a1aea1e31d9427fe58c42574e1d76c1563c42ee44c054797fbef8243c0ba50 |
| geist-mono-cyrillic-400-normal.woff2 | c3e3d9893a3de6713b06bc2fadeacafd9ec05594c5ed18f2e23383669d9dbb9f |
| geist-mono-cyrillic-500-normal.woff2 | 4c8a1cdd921e467c7f8d410b2308986a3acdf1065b9e0bdc4976108a855edb1f |
| oswald-cyrillic-400-normal.woff2 | 8969c189009d0e762aa38db38976c580610d20132e743403ce0b109c8b39781d |
| oswald-cyrillic-500-normal.woff2 | b1b3edd595075432adf5b5a73a6cb0bcf496ebff2efd341c1857bce34441326c |
