# Contributing

Thanks for helping. The most useful thing you can send is a failing test that
shows a call the guard should have stopped and didn't.

## Ground rules

- **npm only.** Use `npm ci`, and commit the updated `package-lock.json` when you
  change dependencies. Do not add a `yarn.lock`, `pnpm-lock.yaml` or `bun.lock`.
- **Tests are required.** Every change to the caps, the hang-up path, tickets or
  a ledger comes with a Vitest test. Tests mock OpenAI (`test/helpers.ts`) and
  must never call the real API or need a real key.
- **Fail closed.** If the guard cannot tell what a call is costing, it ends the
  call. Changes that keep a call running when metering fails need a strong case
  in the PR description.
- **Documented endpoints only.** A new OpenAI endpoint, event or usage field
  needs a link to OpenAI's public documentation in the PR description.
- **Price changes need a source.** Edits to `prices.json` update `checked` and
  link the page the numbers came from.
- **New ledgers pass the contract.** Add the ledger to the `describe.each` list
  in `test/ledger.test.ts`; it must pass every case there.
- **No real data.** Never paste an API key, ticket, SDP, transcript or provider
  payload from a real call into an issue, test or commit.

## Workflow

```bash
npm ci
npm run check   # lint, typecheck, test, build, licence check
```

To run the ledger tests against a real Redis as well, set `REDIS_URL` (CI does).

## Developer Certificate of Origin

Every commit must be signed off, certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/):

```bash
git commit -s -m "Add a ledger for Postgres"
```

That adds a line like `Signed-off-by: Your Name <you@example.com>` using your git
identity. CI checks every commit in a pull request for that line, and PRs with
unsigned commits cannot be merged.

## Code of conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
