# Moving DNS off Microsoft to Squarespace

> **Superseded on 2026-10-11 — do not run this.**
>
> Artemis moved to its own domain,
> [artemisai-bycutlineindustries.studio](./dns-artemis-domain.md). The only
> reason to touch this zone was to move the website onto Vercel, and the website
> is now served from that domain instead.
>
> So `cutline-industries.studio` stays exactly as it is: Microsoft nameservers,
> Squarespace apex, mail untouched. `api.cutline-industries.studio` already
> resolves to the gateway under Microsoft DNS and keeps working with no change.
>
> That removes the whole risky part of this plan — re-keying MX, SPF and two DKIM
> selectors by hand, then a nameserver flip with up to 48 hours of delegation
> during which mail could land nowhere. None of it is necessary any more.
>
> Kept below as a capture of the live zone, which is still accurate and still
> the reference if the company site is ever moved.

**Captured live on 2026-10-10.** Authoritative nameservers today are
`ns1..ns4.bdm.microsoftonline.com` (Microsoft). The Squarespace DNS page is inert
until the nameservers change.

## Order matters

1. Create **every** record below in Squarespace first, while Microsoft is still serving.
2. Only then switch the nameservers to Squarespace.
3. Check mail and the API after it propagates (up to 48h, usually under an hour).

Flipping the nameservers first takes email and the Artemis API down for the gap.

---

## 1. Website — the change you actually want

| Type | Host | Value | Note |
| --- | --- | --- | --- |
| A | `@` | `76.76.21.21` | Vercel. Replaces the six Squarespace IPs. |

The six A records being replaced: `198.185.159.144`, `198.185.159.145`,
`198.49.23.144`, `198.49.23.145`, `216.150.16.193`, `216.150.16.129`.

Optional, and only if you also add `www.cutline-industries.studio` as a domain in
the Vercel project first — otherwise it serves a 404:

| Type | Host | Value |
| --- | --- | --- |
| CNAME | `www` | `cname.vercel-dns.com` |

Currently `www` is a CNAME to `ext-sq.squarespace.com`.

## 2. Artemis API — must be carried over exactly

| Type | Host | Value |
| --- | --- | --- |
| A | `api` | `172.203.229.191` |

This is what makes `api.cutline-industries.studio` serve Artemis. Losing it takes
the chat on the site down.

## 3. Email and identity — Microsoft 365

Keep all of these for as long as mail is on Microsoft 365. They are the cost of
the mailboxes, not of Microsoft DNS.

| Type | Host | Value |
| --- | --- | --- |
| MX | `@` | `cutlineindustries-studio01i.mail.protection.outlook.com` (priority 0) |
| TXT | `@` | `v=spf1 include:spf.protection.outlook.com -all` |
| TXT | `@` | `MS=ms75052723` |
| TXT | `@` | `mscid=0KMli6tqJLftkpMvAmzxVMP1yKo4WPsRHCEELdU5YSVudr+hncdD/zVnFAQIeXyQWSkPH5R9mq5efOqF2s5FSw==` |
| TXT | `_dmarc` | `v=DMARC1; p=none` |
| CNAME | `autodiscover` | `autodiscover.outlook.com` |
| CNAME | `selector1._domainkey` | `selector1-cutlineindustries-studio01i._domainkey.cutlineindustriesstudio.d-v1.dkim.mail.microsoft` |
| CNAME | `selector2._domainkey` | `selector2-cutlineindustries-studio01i._domainkey.cutlineindustriesstudio.d-v1.dkim.mail.microsoft` |

The two DKIM selectors are what stop your mail being marked as spam. The `MS=`
record is how Microsoft proves you own the domain; remove it and the domain can
be dropped from the tenant.

## 4. Optional — drop these unless you use them

| Type | Host | Value | What it is |
| --- | --- | --- | --- |
| CNAME | `enterpriseregistration` | `enterpriseregistration.windows.net` | Entra device join |
| CNAME | `enterpriseenrollment` | `enterpriseenrollment-s.manage.microsoft.com` | Intune enrolment |
| A | `artemis` | `216.150.1.65`, `216.150.16.1`, `216.150.1.193` | points at Squarespace; decide what it should serve |

## 5. Switch the nameservers

Squarespace → **Domains** → `cutline-industries.studio` → nameservers → switch
from custom back to Squarespace's own. The banner on the DNS Settings page goes
away, and the records above become live.

## 6. Verify

```
# the site should leave Squarespace
dig +short cutline-industries.studio          # expect 76.76.21.21
# the API must not move
dig +short api.cutline-industries.studio      # expect 172.203.229.191
# mail must still route to Microsoft
dig +short MX cutline-industries.studio
dig +short TXT cutline-industries.studio
```

Send yourself an email from an outside address as the real test. DNS resolving
is not the same as mail being delivered.

---

## If you want Microsoft gone entirely

That is a mailbox migration, not a DNS change: move the mail to another provider
(Fastmail, Google Workspace, Zoho), repoint MX and SPF at them, publish their
DKIM, and only then delete the Microsoft records. Done in the other order you
lose mail in flight.
