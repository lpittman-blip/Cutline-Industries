#!/usr/bin/env bash
# Stand up a Google Cloud project an agent can drive, and report honestly on
# the two things that will actually block it.
#
# RUN THIS IN GOOGLE CLOUD SHELL: https://shell.cloud.google.com
# Cloud Shell is free, browser-based, and already authenticated as you, so
# there is nothing to install and no browser handoff. Paste the whole script.
#
# It does NOT spend money and it does NOT enable billing — it cannot. Billing
# needs a payment instrument, which is exactly the constraint this is working
# around. What it does is make everything else ready and then tell you, plainly,
# whether billing and GPU quota are in your way.
#
# Output at the end: the path of a service-account key file. Supply that to
# automation as an ENVIRONMENT SECRET. Do not paste it into a chat, a ticket or
# a commit — it is a private key granting compute control of the project.
set -euo pipefail

PROJECT="${PROJECT:-artemis-train-$RANDOM}"
SA="${SA:-artemis-agent}"
REGION="${REGION:-us-central1}"
KEY_OUT="${KEY_OUT:-$HOME/artemis-agent-key.json}"

say() { printf '\n=== %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }

command -v gcloud >/dev/null || { echo "run this in Cloud Shell, where gcloud is preinstalled"; exit 1; }

say "1. project"
if gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
  note "using existing project $PROJECT"
else
  gcloud projects create "$PROJECT" --name="Artemis training" --quiet
  note "created $PROJECT"
fi
gcloud config set project "$PROJECT" --quiet

say "2. is billing enabled? (this is the wall, and this script cannot climb it)"
# GA surface, not `beta`: `gcloud billing projects describe` exists in the GA
# command set, while `gcloud beta billing ...` needs the beta component, which
# a default install does not have. Verified against gcloud 589.0.0 — the beta
# form was MISSING there and the GA form resolved.
BILLING=$(gcloud billing projects describe "$PROJECT" \
            --format="value(billingEnabled)" 2>/dev/null || echo "unknown")
if [ "$BILLING" = "True" ]; then
  note "billing: ENABLED — good, compute can run"
else
  cat <<'MSG'
  billing: NOT ENABLED.

  Nothing below will be able to start a VM until a billing account is linked
  to this project. Linking one requires a payment instrument. Google's own
  eligibility page for INVOICED (net-terms, no card) billing requires:
    - registered as a business for a minimum of one year
    - expected spend of at least $40,000/year on Google Cloud
    - invoiced billing offered in your country
  A small training run does not meet that bar, so on a new account this is a
  card, or a Google Cloud free trial (which also asks for a card to verify
  identity, even though it does not charge it).

  Link one at: https://console.cloud.google.com/billing/linkedaccount
  Then re-run this script; everything else is idempotent.
MSG
fi

say "3. enable the APIs the agent needs"
gcloud services enable compute.googleapis.com --quiet 2>&1 | tail -2 || \
  note "enabling compute API failed — this usually means billing is not linked yet"

say "4. service account for the agent"
if gcloud iam service-accounts describe "$SA@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1; then
  note "service account already exists"
else
  gcloud iam service-accounts create "$SA" --display-name="Artemis training agent" --quiet
fi
# compute.admin to create/delete the VM and disks; serviceAccountUser so the
# VM can be created with a service account attached. Deliberately NOT owner,
# NOT billing admin: this key must not be able to change billing or IAM.
for ROLE in roles/compute.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$SA@$PROJECT.iam.gserviceaccount.com" \
    --role="$ROLE" --quiet >/dev/null
  note "granted $ROLE"
done

say "5. GPU quota — check it NOW, before anyone plans around it"
# A brand-new GCP project has a GPU quota of ZERO in every region, exactly as
# the Azure subscription did. Finding that out here costs nothing; finding it
# out after arranging billing wastes a round trip.
gcloud compute regions describe "$REGION" \
  --format="table[box](quotas.metric,quotas.limit,quotas.usage)" 2>/dev/null \
  | grep -iE "GPU|NVIDIA|PREEMPTIBLE_NVIDIA|metric" || \
  note "could not read quotas (compute API may not be enabled yet)"
cat <<MSG
  If every GPU limit above reads 0, a quota increase is needed before any GPU
  VM can start, regardless of billing:
    https://console.cloud.google.com/iam-admin/quotas
  Request the metric NVIDIA_T4_GPUS (or NVIDIA_L4_GPUS) = 1 in $REGION.
  The request is free and goes to human review.
MSG

say "6. key for the agent"
if [ -f "$KEY_OUT" ]; then
  note "a key file already exists at $KEY_OUT — not creating another"
  note "list existing keys: gcloud iam service-accounts keys list --iam-account $SA@$PROJECT.iam.gserviceaccount.com"
else
  gcloud iam service-accounts keys create "$KEY_OUT" \
    --iam-account="$SA@$PROJECT.iam.gserviceaccount.com" --quiet
  chmod 600 "$KEY_OUT"
fi

cat <<MSG

=== done

  project          $PROJECT
  service account  $SA@$PROJECT.iam.gserviceaccount.com
  key file         $KEY_OUT
  billing enabled  $BILLING

  HANDING THE KEY OVER. It is a private key. Download it from Cloud Shell
  (three-dot menu -> Download) and give it to automation as an environment
  secret, or paste its contents into a secret manager. Never into a chat
  message, an issue, or a commit.

  The agent then authenticates with:
    gcloud auth activate-service-account --key-file=<path>
    gcloud config set project $PROJECT

  REVOKE when the run is finished:
    gcloud iam service-accounts keys list --iam-account $SA@$PROJECT.iam.gserviceaccount.com
    gcloud iam service-accounts keys delete <KEY_ID> --iam-account $SA@$PROJECT.iam.gserviceaccount.com

  NOT TESTED against a live project: this was written without Google Cloud
  credentials to run it. Expect to fix a flag. The logic is ordinary gcloud
  and the failure modes are reported rather than hidden.
MSG
