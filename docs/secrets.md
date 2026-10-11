# Secrets: where they live, and why not yet in the gateway process

State as of 2026-10-11.

## The rule

Secrets live in Azure Key Vault `artemis-kv-6b22c1`. Never in code, chat,
tickets or logs, and nobody is ever asked to paste one into a conversation.

The vault is in subscription **`bd193cb1-661c-44cc-bb7f-04d545296da8`**, resource
group `artm-rg`, RBAC-authorization enabled. Note that is **not** the
subscription the gateway VM lives in (`65c3f7b2-…`), and `az keyvault list`
against the default subscription does not show it — which is why it can look
missing while its secrets read fine on the data plane.

Two other vaults exist in `artm-rg` on the default subscription,
`artemisakeyvault5a113860` and `artemismkeyvault0d20b54c`. Neither is referenced
by anything in this repo; they look like strays from earlier provisioning and
are worth auditing before someone assumes one of them is authoritative.

## What the vault holds

| secret | consumer | status |
| --- | --- | --- |
| `artemis-database-url` | `ARTEMIS_DATABASE_URL` | present |
| `azure-ai-key` | `AZURE_AI_KEY` | **not created yet** |
| `xai-api-key` | `XAI_API_KEY` (Grok add-on) | **not created yet** |

Create the missing two from the portal or your own terminal. Not from an agent
session, and not by pasting the value into a chat.

## The intended design, and why it is blocked

The gateway should read Key Vault itself at boot, so no secret ever rests on
disk. That requires a managed identity on `cutline-vps`. Assigning one fails:

```
FailedIdentityOperation … "The directory object quota limit for the Tenant has
been exceeded. Please ask your administrator to increase the quota limit or
delete objects to reduce the used quota."
```

A managed identity — system-assigned or user-assigned — is a service principal,
and a service principal is a directory object, so neither variant avoids the
quota. A service principal with a client secret does not either.

**To unblock, a tenant administrator must** raise the Entra directory object
quota (a Microsoft support request) or delete unused directory objects —
typically stale app registrations and service principals — to free headroom.
Counting what is there needs Entra read permissions, which the automation
account does not have, so an administrator has to look.

Once that is done the remaining work is small: `az vm identity assign`, grant
the new principal **Key Vault Secrets User** scoped to the vault (cross-
subscription is fine), and have the gateway resolve secrets through IMDS at
startup with the env var as fallback.

## What works today

`infra/azure/sync-secrets.sh` pushes vault values into the VM's environment
file. The vault stays the single source of truth, nothing lives in git, and
rotation becomes "update the vault, run the script".

```bash
bash infra/azure/sync-secrets.sh --check   # what differs; values never printed
bash infra/azure/sync-secrets.sh           # pull, write, restart, verify
```

What it does not buy: the secret still rests in `/etc/artemis-chat.env`, root-
owned and mode 600. That is precisely the part the managed identity would have
removed, so this is an interim measure, not the destination.

**Run it from a machine with SSH to the VM.** Port 22 is blocked outbound from
Claude and Codex cloud containers to every host, so it cannot run from an agent
session. It needs `az login` and a key the VM already trusts.

Implementation notes that matter if you edit it:

- Values are never printed, and never passed as command arguments, so they stay
  out of `ps` output and shell history on both ends. The write uses
  `install -m 600 /dev/stdin`.
- The merge is plain bash, deliberately. `awk -v` expands backslash escapes in
  the replacement, so a secret containing `\n` gets split across two lines and
  the env file breaks; `sed` treats `&` and `/` as syntax. Both were tested and
  both corrupt real values.
- Only the mapped variables are rewritten. `PORT`, `ARTEMIS_BIND`,
  `ARTEMIS_ALLOWED_ORIGINS`, the bootstrap flag and everything else are
  preserved byte for byte.
- The previous file is kept at `/etc/artemis-chat.env.bak` and the script prints
  the one-line rollback if the service or health check fails.

## Trap: do not re-run setup-vps-gateway.sh on the live box

`infra/azure/setup-vps-gateway.sh` **overwrites** `/etc/artemis-chat.env` with a
fixed template. That template writes `VLLM_BASE_URL`, `VLLM_MODEL` and
`VLLM_API_KEY` and does **not** write any of the `AZURE_AI_*` variables or
`ARTEMIS_BOOTSTRAP_AZURE`.

Re-running it against `cutline-vps` today would drop the Azure bootstrap
configuration and set the VLLM variables empty. Empty is falsy in
`server.build_app()`, so the gateway would fall through to `NotReadyBackend` and
every chat request would start failing. It is a first-time provisioning script;
treat it as one.
