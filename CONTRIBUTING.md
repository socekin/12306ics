# Contributing

Thanks for helping. Bug reports, samples of new 12306 email formats, and pull requests are all welcome.

## Reporting a problem

Open an [issue](https://github.com/socekin/12306ics/issues/new/choose) and include:

- what you expected and what happened,
- the response of `/ingest` or the entry in `/raw`, if any,
- relevant `npx wrangler tail` output.

**Never paste a raw 12306 email or your tokens.** Emails contain your name, order numbers, and
travel details. If an email is needed, anonymise it first as described below.

## Development setup

Requires Node.js 22 or later.

```bash
npm install
npm test            # unit tests (Vitest)
npm run typecheck   # tsc --noEmit
npm run dev         # local Worker; needs wrangler.jsonc and .dev.vars, see docs/deployment.md
```

Tests do not need a Cloudflare account; KV, CalDAV, and the 12306 lookup are faked in
[`test/helpers.ts`](test/helpers.ts).

## Project structure

See [docs/architecture.md](docs/architecture.md) for the source layout, data model, and processing
pipeline.

## Adding support for a new email

1. **Save an anonymised fixture** under `test/fixtures/<name>.json` with the fields
   `{subject, from, date, html, text}`. Before committing:
   - replace passenger names with `乘客甲`, `乘客乙`, …
   - replace order numbers with `E20000000N`
   - remove ID numbers, phone numbers, and email addresses, including in the greeting line
2. **Classify it**: add a subject rule to `SUBJECT_RULES` in [`src/parse.ts`](src/parse.ts), and a body
   fallback only if the subject is ambiguous.
3. **Apply it**: add the reducer to [`src/trip.ts`](src/trip.ts) and wire it into `applyEmail`.
4. **Test it**: add parse and trip tests, then run `npm test` and `npm run typecheck`.
5. **Document it** in [docs/email-formats.md](docs/email-formats.md).

## Pull requests

- Keep each pull request focused on one change.
- Match the surrounding code style: TypeScript strict mode, two-space indentation, single quotes.
- Write code, comments, commit messages, and documentation in English. Chinese is fine in test
  fixtures and in user-visible event text.
- Use imperative commit subjects, for example `Parse refund notices without ticket lines`.
- Add or update tests for behaviour changes, and update the docs and [CHANGELOG.md](CHANGELOG.md)
  when users would notice the change.
- CI must pass: `npm run typecheck` and `npm test`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
