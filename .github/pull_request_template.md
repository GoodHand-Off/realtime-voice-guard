## What this changes

<!-- One or two sentences. -->

## OpenAI documentation

<!-- Link the public OpenAI docs for any endpoint, event, usage field or price you add or change. -->

## Checklist

- [ ] `npm run check` passes locally
- [ ] New behaviour has a test against the mocked OpenAI in `test/helpers.ts`
- [ ] The guard still fails closed: if it cannot meter a call, it ends it
- [ ] No real keys, tickets, SDP or transcripts in code, tests or this PR
- [ ] Commits are signed off (`git commit -s`)
- [ ] `CHANGELOG.md` updated under "Unreleased"
