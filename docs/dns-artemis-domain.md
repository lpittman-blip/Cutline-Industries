# artemisai-bycutlineindustries.studio — the Artemis product domain

Registered 2026-10-11 at Squarespace. As of writing the registry still answers
NXDOMAIN for it: a fresh `.studio` registration takes up to an hour to delegate.
Nothing below works until `dig NS artemisai-bycutlineindustries.studio` returns
nameservers.

This domain is a clean slate. It carries no mail and no Microsoft records, so
none of the care required by [dns-migration.md](./dns-migration.md) applies. If
it was bought at Squarespace it is already on Squarespace nameservers, which
means its DNS Settings page is live immediately — no nameserver switch, no
48-hour delegation wait, no cutover risk.

## Records

| Type | Host | Value | Why |
| --- | --- | --- | --- |
| A | `@` | `76.76.21.21` | Vercel. Serves the Artemis product site. |
| CNAME | `www` | `cname.vercel-dns.com` | Already added to Vercel as a 308 redirect to the apex. |
| A | `api` | `172.203.229.191` | `cutline-vps`, the Artemis gateway. |

Delete any "Squarespace Defaults" or "Squarespace Domain Connect" preset group
first. The HTTPS/SVCB record inside it carries an `ipv4hint` that keeps browsers
going to Squarespace even once the A record is right — the failure that looks
like broken DNS when the DNS is fine.

## The site needs no API work

`vercel.json` rewrites `/api/*` and `/v1/*` to the gateway server-side, and both
domains are on the same Vercel project, so the chat UI on the new domain reaches
Artemis through that rewrite the moment DNS resolves. The browser never makes a
cross-origin request, so no CORS change and no certificate are needed for the
site to work.

The `api` hostname below is for **direct API customers** — the CLI and anything
holding an API key — so they get a product-branded endpoint instead of calling
the company domain.

## Certificate for the API hostname

nginx on `cutline-vps` terminates TLS with certbot. The new hostname is an
expansion of the existing certificate, not a second one. Run only after the
`api` A record resolves, or the ACME challenge fails:

```
certbot --nginx \
  -d api.cutline-industries.studio \
  -d api.artemisai-bycutlineindustries.studio \
  --expand --non-interactive --agree-tos \
  -m lpittman@cutline-industries.studio --redirect
```

`server_name` in `/etc/nginx/sites-available/artemis-chat` must list both names
before this runs. Keep `api.cutline-industries.studio` serving permanently —
anything already pointed at it keeps working, and retiring a published API
hostname is a breaking change for customers.

## Verify

```
dig +short artemisai-bycutlineindustries.studio      # expect 76.76.21.21
dig +short api.artemisai-bycutlineindustries.studio  # expect 172.203.229.191
curl -sS https://api.artemisai-bycutlineindustries.studio/v1/status
curl -sSI https://www.artemisai-bycutlineindustries.studio   # expect 308 to apex
```
