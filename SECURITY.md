# Security policy

bridge handles device credentials, keychain entries, end-to-end encrypted relay traffic and the containment of
local coding agents. A flaw in any of these can expose a user's machine, so report it privately.

## Reporting a vulnerability

Do not open a public issue, discussion or pull request for a vulnerability.

Report it through GitHub's private vulnerability reporting:
[open a private advisory](https://github.com/berdyh/bridge/security/advisories/new). Only the maintainers can
read it. Include:

- the affected package and version (`bridge --version` for the runner);
- what an attacker controls (a hosted page, a relay, a plugin, another app's connection, a local process) and what
  they gain;
- steps or a proof of concept against a local setup, never against someone else's deployment;
- whether it is already public anywhere.

You get an answer within a week. Once a fix is released, the advisory is published with credit to you unless you
ask otherwise.

## In scope

- the runner and CLI (`@berdyh/bridge`, `@berdyh/bridge-runner`): pairing, enrollment, keychain access, agent and
  plugin containment, the separation between apps that share one runner;
- the relay and server kit (`@berdyh/bridge-server*`): authentication, device records, relay routing;
- the wire protocol and crypto (`@berdyh/bridge-protocol`, `@berdyh/bridge-crypto`, `@berdyh/bridge-pairing`);
- the client and plugin SDKs, and `scripts/install.sh`.

## Out of scope

- an app that uses the kit: report to that app's maintainers, unless the flaw is in the kit itself;
- the agents bridge launches (claude, codex and other ACP agents) and their own permission systems;
- findings that need an already compromised user account or machine.
