#! /usr/bin/env bash

count=0
while true
do
  count=$((count + 1))
  echo "Request $count at $(date)"
  curl https://api.openai.com/v1/completions --silent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "OpenAI-Organization: $OPENAI_ORG_ID" \
  -d '{"model": "code-davinci-002", "prompt": "const x = () => {}", "temperature": 0, "max_tokens": 7}' | jq
  echo
  sleep 12
done