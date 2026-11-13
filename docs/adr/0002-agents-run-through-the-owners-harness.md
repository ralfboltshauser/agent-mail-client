# Agents run through the owner's installed Harness, not API keys

Every Agent runs via the Vercel AI SDK harness agent on top of the Claude Code / Codex CLI the owner has installed and logged in on the Host, so it rides their existing subscriptions. There is deliberately no API-key LLM provider, not even as a fallback: one path, no key management, no second bill. Revisit only if the harness path proves unable to do something essential.
