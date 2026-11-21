#!/usr/bin/env bash
set -euo pipefail

project=amc-mail-x097y3
topic=amc-gmail
subscription=amc-gmail-host
account=amc-gmail-subscriber
account_email="$account@$project.iam.gserviceaccount.com"

gcloud services enable pubsub.googleapis.com iam.googleapis.com --project="$project"

existing_topic=$(gcloud pubsub topics list --project="$project" \
  --filter="name=projects/$project/topics/$topic" --format='value(name)')
if [[ -z "$existing_topic" ]]; then
  gcloud pubsub topics create "$topic" --project="$project"
fi
gcloud pubsub topics add-iam-policy-binding "$topic" --project="$project" \
  --member='serviceAccount:gmail-api-push@system.gserviceaccount.com' \
  --role='roles/pubsub.publisher'

existing_subscription=$(gcloud pubsub subscriptions list --project="$project" \
  --filter="name=projects/$project/subscriptions/$subscription" --format='value(name)')
if [[ -z "$existing_subscription" ]]; then
  gcloud pubsub subscriptions create "$subscription" --project="$project" \
    --topic="$topic" --expiration-period=never
fi
subscription_topic=$(gcloud pubsub subscriptions describe "$subscription" --project="$project" \
  --format='value(topic)')
delivery_endpoint=$(gcloud pubsub subscriptions describe "$subscription" --project="$project" \
  --format='value(pushConfig.pushEndpoint,bigqueryConfig.table,cloudStorageConfig.bucket)' |
  tr -d '[:space:]')
if [[ "$subscription_topic" != "projects/$project/topics/$topic" || -n "$delivery_endpoint" ]]; then
  echo "Expected $subscription to be a pull subscription for $topic." >&2
  exit 1
fi

existing_account=$(gcloud iam service-accounts list --project="$project" \
  --filter="email=$account_email" --format='value(email)')
if [[ -z "$existing_account" ]]; then
  gcloud iam service-accounts create "$account" --project="$project" \
    --display-name='AMC Gmail Pub/Sub subscriber'
fi
# IAM can take a short time to recognize a newly created service account.
for attempt in {1..12}; do
  if output=$(gcloud pubsub subscriptions add-iam-policy-binding "$subscription" --project="$project" \
    --member="serviceAccount:$account_email" --role='roles/pubsub.subscriber' 2>&1); then
    printf '%s\n' "$output"
    break
  fi
  if [[ "$output" != *"Service account $account_email does not exist."* || "$attempt" == 12 ]]; then
    printf '%s\n' "$output" >&2
    exit 1
  fi
  sleep 5
done
