# artemisai-bycutlineindustries.studio — the Artemis product domain

Registered 2026-10-11 at Squarespace and delegated the same day to
`nsd1..nsd4.squarespacedns.com`. The DNS Settings page is live now.

This domain is a clean slate. It carries no mail and no Microsoft records, so
none of the care required by [dns-migration.md](./dns-migration.md) applies —
no nameserver switch, no 48-hour delegation wait, no cutover risk.

## 1. Delete the Squarespace defaults first

Squarespace pre-populated the zone, and it is serving the parking page:

| Type | Host | Value |
| --- | --- | --- |
| A | `@` | `198.185.159.144`, `198.185.159.145`, `198.49.23.144`, `198.49.23.145` |
| HTTPS | `@` | `alpn=h2,http/1.1 ipv4hint=198.185.159.144,198.185.159.145,198.49.23.144,198.49.23.145` |
| CNAME | `www` | `ext-sq.squarespace.com` |

All of it goes. The **HTTPS record matters most**: its `ipv4hint` hands browsers
Squarespace's addresses directly, so a browser keeps landing on Squarespace even
after the A record points at Vercel. Changing the A records without deleting this
one produces a site that looks broken while `dig` says everything is correct.

## 2. Records to add

| Type | Host | Value | Why |
| --- | --- | --- | --- |
| A | `@` | `76.76.21.21` | Vercel. Serves the Artemis product site. |
| CNAME | `www` | `cname.vercel-dns.com` | Already added to Vercel as a 308 redirect to the apex. |
| A | `api` | `172.203.229.191` | `cutline-vps`, the Artemis gateway. |

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
