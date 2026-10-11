#!/usr/bin/env bash
# Deploy the Artemis chat gateway as a new Azure Container App.
# Prerequisites: az login, ACR push access, DATABASE_URL and VLLM_BASE_URL set.
#
# Usage:
#   ACR=cutlineacr.azurecr.io RG=<resource-group> bash infra/azure/deploy-chat.sh
#
# After deploy the script prints the gateway URL. Run:
#   python infra/prepare-vercel.py --gateway-url <URL>
# then redeploy the Vercel project to activate same-origin API routing.

set -euo pipefail

ACR="${ACR:?Set ACR to your Azure Container Registry, e.g. cutlineacr.azurecr.io}"
RG="${RG:?Set RG to your Azure resource group}"
APP_NAME="${APP_NAME:-artemis-chat}"
IMAGE="$ACR/$APP_NAME:latest"
ENV_NAME="${CONTAINERAPPS_ENV:-artemis-env}"

echo "[deploy-chat] Building image $IMAGE …"
docker build -f Dockerfile.chat -t "$IMAGE" .
docker push "$IMAGE"

echo "[deploy-chat] Creating/updating Container App $APP_NAME …"
az containerapp up \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --image "$IMAGE" \
  --environment "$ENV_NAME" \
  --ingress external \
  --target-port 8080 \
  --cpu 1 \
  --memory 2Gi \
  --min-replicas 1 \
  --max-replicas 3 \
  --set-env-vars \
    "PORT=8080" \
    "ARTEMIS_BIND=0.0.0.0" \
    "ARTEMIS_COOKIE_SECURE=1" \
    "VLLM_BASE_URL=${VLLM_BASE_URL:-}" \
    "VLLM_MODEL=${VLLM_MODEL:-}" \
    "DATABASE_URL=${DATABASE_URL:-}" \
    "ARTEMIS_ALLOWED_ORIGINS=${ARTEMIS_ALLOWED_ORIGINS:-https://cutline-industries.studio,https://artemisai-bycutlineindustries.studio,https://www.artemisai-bycutlineindustries.studio}"

URL=$(az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --query "properties.configuration.ingress.fqdn" \
  --output tsv)

echo ""
echo "[deploy-chat] Gateway live at: https://$URL"
echo ""
echo "Next: update vercel.json rewrites"
echo "  python infra/prepare-vercel.py --gateway-url https://$URL"
echo "Then redeploy Vercel:"
echo "  vercel --prod"
