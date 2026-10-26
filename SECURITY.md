# Security policy

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub instead: go to the repository's **Security** tab and click **Report a vulnerability** ([direct link](https://github.com/polius/Flow/security/advisories/new)).

Include what you found, how to reproduce it, and which version you tested (shown next to the Flow logo, or returned by `/api/health`). Fixes ship in a new release, and the advisory is published once an upgrade is available.

## Supported versions

Only the latest release gets security fixes. Upgrading is a `docker compose pull` (see [Upgrading](README.md#upgrading)).

## Hardening

Flow is built for a home network. Before exposing it to the internet:

- Set a password ([Password](README.md#password)). Flow has none by default.
- Put it behind HTTPS ([HTTPS and reverse proxies](README.md#https-and-reverse-proxies)).
