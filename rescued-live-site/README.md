# Rescued copy of the deployed site — 2026-10-11

Downloaded from `https://artemisai-bycutlineindustries.studio` on 2026-10-11.
This is **what production actually serves**, which is not what `main` contains.

## Why this exists

Vercel is not deploying from GitHub. Every production deployment on this project
has empty git metadata, so pushes to `main` never reach the site, and the live
site was uploaded by hand from a working copy that diverged from the repo.

Five files here exist in **no commit on any branch**:

| File | Size | Referenced by |
| --- | --- | --- |
| `chat-orb.css` | 61 KB | `chat/index.html` |
| `chat-orb.js` | 61 KB | `chat/index.html` |
| `live.css` | 17 KB | `index.html` |
| `live.js` | 17 KB | `index.html` |
| `chat-hero.css` / `chat-hero.js` | 16 KB | — (orphaned on the live site) |

Deploying `main` over production would have destroyed all of it permanently.
`ms89530045.txt` is also live-only — it is the Microsoft domain-verification
file for the M365 tenant, and losing it can drop the domain and take mail down.

## How the two versions differ

`main` is **newer in routing**: it moved the chat from `/chat/` to `/artemisai/`,
added `api-client.js`, and bumped the service-worker cache to `artemis-shell-v2`.
Production still serves `/chat/` and `artemis-shell-v1`, and has no
`api-client.js` or `artemisai/` directory at all — which is why
`/artemisai/` returns 404 in production while `/chat/` works.

Production is **newer in UI**: the orb and live-view work above.

So neither side is simply ahead. A merge has to be deliberate.

Cosmetically identical (one stray blank line only): `account-motion.js`,
`artemis-theme.css`, `chat-render.js`, `chat-stream.js`, `manifest.webmanifest`,
`mobile.css`, `polish.js`.

Genuinely different: `index.html`, `main.js`, `workspace.js`, `workspace.css`,
`styles.css`, `sw.js`, `app.js`, and the three sub-page `index.html` files.

## Before touching production again

Connect the Vercel project to GitHub so deployments come from a commit. Until
then the live site is the only copy of part of itself, and any deploy is a
gamble.
