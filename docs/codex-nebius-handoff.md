# Nebius access handoff for Codex

Set up 2026-10-11. Target: let Codex operate the existing `artemis-8gpu` VM —
`computeinstance-e00hf3ff9c9d3g63z1` in `project-e00yn51ypr007sqnbn1x9t`.
**No new VM is to be created.**

## First, the thing that cannot be done

**Claude cannot configure credentials inside Codex's execution environment.**
The two run in separate, isolated containers with no shared filesystem, no
shared secret store and no channel between them. The only way to "share"
authentication would be to move a private key through this conversation, which
is exactly what must never happen.

So the handoff is split: everything that does **not** involve secret material is
already done, server-side, and verified below. The one step that does involve
secret material is yours, and it goes browser → Codex's secret store, never
through a chat message.

## Done and verified

A dedicated identity now exists. Codex does **not** get the tenant-admin
account whose keys leaked.

| | |
| --- | --- |
| service account | `serviceaccount-e00vtzxm35ebf0zmm2` (`artemis-codex`) |
| parent | `project-e00yn51ypr007sqnbn1x9t` |
| group | `editors` (`group-e00wny59w1pny4ga97`) |
| effective role | `editor` — compute start/stop/inspect, not `admin` |
| credentials | **none yet** — step 1 below |

### Verification results (non-secret)

Run against the live API, not inferred:

| check | result |
| --- | --- |
| instance inspection | **pass** — `artemis-8gpu`, `STOPPED`, `gpu-h100-sxm`, `8gpu-128vcpu-1600gb` |
| serial/platform log query | **pass** — authorized, exit 0 (empty: VM stopped >72h, so no recent lines) |
| IAM read | **pass** — key list, group list, permit list |
| IAM write | **pass** — two access-key deactivations applied and confirmed |
| service-account create | **pass** — `artemis-codex` created |
| group create | **denied** — `PermissionDenied` at both project and tenant scope |
| compute **start** | **not tested, deliberately** — see below |
| VM left stopped | **confirmed** — still `STOPPED` after all of the above |

**Why start was not tested.** Nebius has no dry-run on `compute instance start`,
and permits cannot be enumerated per-subject (they attach to groups, and a
service account cannot be a permit parent). The only decisive test is starting
the VM, which you excluded and which bills at ~$98/hour. The `editor` role on
the `editors` group is the role that grants it; Codex's preflight establishes it
for real on first start.

**Why there is no dedicated least-privilege group.** `iam group create` returns
`PermissionDenied` for this account at both project and tenant scope — group
management appears reserved to a tenant owner. Since access permits attach only
to groups, membership in an existing group is the only way to grant a service
account anything. `editors` was the narrowest group that covers VM operation.
If you want a tighter, project-scoped group, create it as tenant owner:

```bash
nebius iam group create --parent-id tenant-e00wxvkryxs522aaxt --name codex-operators
nebius iam access-permit create --parent-id <new-group-id> \
  --resource-id project-e00yn51ypr007sqnbn1x9t --role editor
nebius iam group-membership create --parent-id <new-group-id> \
  --member-id serviceaccount-e00vtzxm35ebf0zmm2
nebius iam group-membership delete --parent-id group-e00wny59w1pny4ga97 \
  --member-id serviceaccount-e00vtzxm35ebf0zmm2
```

That scopes Codex to the one project instead of tenant-wide `editor`.

## Credential rotation — done

Both exposed keys on `serviceaccount-e04nwdxcrjmat9y8q0` are now **INACTIVE**:

| key | aws id | why | state |
| --- | --- | --- | --- |
| `accesskey-e04vgf5etvwrs9zcv7` | `NAKI7IMXPX2AHHEALYCR` | posted in a chat message | INACTIVE |
| `accesskey-e00zdh5pd3q0dcjxy4` | `NAKITSIEJ5JHCENYJJ01` | its secret was leaked into a transcript | INACTIVE |

Deactivated rather than deleted, because deactivation is immediate, reversible
and provably sufficient — the leaked material no longer authenticates. Delete
them once you have confirmed nothing else used them:

```bash
nebius iam v2 access-key delete --id accesskey-e04vgf5etvwrs9zcv7
nebius iam v2 access-key delete --id accesskey-e00zdh5pd3q0dcjxy4
```

**Consequence to plan for:** `accesskey-e00zdh5pd3q0dcjxy4` is the credential
`artemis-sync.service` used to write `s3://artemis-train-logs`. Until a
replacement is installed on the VM, status and checkpoint sync will fail. The
VM is stopped, so nothing is broken right now, but Codex's preflight must not
mistake it for a bug.

A third id mentioned earlier, `NAKI2D49M860DKZS905G`, does not exist on this
service account. It was either already removed or never belonged here.

## What you do — three steps, no secrets in chat

**1. Give `artemis-codex` a key.** On your own machine:

```bash
openssl genrsa -out codex-nebius.pem 4096
openssl rsa -in codex-nebius.pem -pubout -out codex-nebius.pub
nebius iam auth-public-key create \
  --parent-id serviceaccount-e00vtzxm35ebf0zmm2 \
  --data "$(cat codex-nebius.pub)"
```

The **public** key is not secret and may be pasted anywhere. `codex-nebius.pem`
is the private key: it goes straight into Codex's secret store and nowhere else.

**2. Install it in Codex's environment.** Codex reads a profile from
`$CODEX_HOME`/`~/.nebius`, so provide:

```yaml
# ~/.nebius/config.yaml  (in Codex's environment)
default: artemis-codex
profiles:
  artemis-codex:
    endpoint: api.nebius.cloud
    parent-id: project-e00yn51ypr007sqnbn1x9t
    service-account-id: serviceaccount-e00vtzxm35ebf0zmm2
    public-key-id: <id returned by step 1>
    private-key-file: /secrets/codex-nebius.pem
```

Mount the private key from the environment's secret storage — Codex Cloud
environment secrets, or a file with mode 600 on a self-hosted runner. Never
commit it, never put it in a prompt.

**3. New S3 key for the log bucket**, once you have decided whether Codex needs
it. `editors` carries `editor` but not the `storage.*` roles — those sit on
`admins` — so Codex cannot write the log bucket yet. Rather than widen a shared
group, grant storage explicitly as tenant owner, then:

```bash
nebius iam v2 access-key create --account-service-account-id serviceaccount-e00vtzxm35ebf0zmm2
```

The secret is shown **once**. Put it directly in Codex's secret store.

## Codex's preflight — read-only, leaves the VM stopped

```bash
nebius compute instance get --id computeinstance-e00hf3ff9c9d3g63z1
nebius iam group-membership list-member-of --subject-id serviceaccount-e00vtzxm35ebf0zmm2
nebius logging query --project-id project-e00yn51ypr007sqnbn1x9t --since 1h '{sp_serial=~".+"}'
```

All three are reads. None starts the VM.

## Guardrails

- **~$98/hour.** Confirm with the owner before every start. No exceptions, and
  the restored write permission does not change this.
- **Do not create another VM.** `artemis-8gpu` is the authorized machine, and it
  is the only one.
- There is no 1–8 middle ground: Nebius offers 1-GPU and 8-GPU presets only.
- Port 22 is blocked outbound from Claude and Codex cloud containers to every
  host. Monitoring goes through `nebius logging query` and the S3 bucket, not
  SSH. Do not ask anyone for a private key to "fix" this.

## Correction to earlier documentation

`docs/TRAINING-HANDOFF.md` and `docs/CODEX-BRIEF.md` both recorded a blocker:
`serviceaccount-e04nwdxcrjmat9y8q0` had lost write permission, with every write
returning `PermissionDenied`.

**That is no longer true.** The account is a member of `admins`
(`group-e00mqgga9j7vgnwcw7`), which carries `admin` plus the storage roles, and
two write operations succeeded today. Whatever broke it was fixed. Both docs
have been updated; this note records that the earlier statement was accurate
when written and is now stale, so a reader who saw it is not left trusting it.
