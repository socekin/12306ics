# Security policy

## Supported versions

| Version            | Supported |
| ------------------ | --------- |
| 2.x (Worker)       | yes       |
| 1.x (Python/Docker) | no       |

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/socekin/12306ics/security/advisories/new),
not in a public issue. Include the affected version, steps to reproduce, and the impact. This is a
personal project maintained on a best-effort basis.

## Hardening your deployment

- **Use long random tokens** (`openssl rand -hex 32`) for `INGEST_TOKEN` and `CALENDAR_TOKEN`, and keep
  them different. `INGEST_TOKEN` can add and remove trips; `CALENDAR_TOKEN` reveals your travel plans.
- **Treat the ICS subscription URL as a secret.** It carries `CALENDAR_TOKEN` in the query string.
  Rotate the token if the URL is shared or leaked.
- **Use an app-specific password** for iCloud CalDAV, never your Apple ID password.
- **Keep `ALLOWED_SENDERS` minimal.** It filters on the `From` header, which is not authentication.
  Remove test addresses when you are done testing, and do not publish the routed email address.
- **Never commit `wrangler.jsonc` or `.dev.vars`.** Both are gitignored; the repository ships
  templates instead.
