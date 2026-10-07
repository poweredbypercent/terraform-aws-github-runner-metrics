# Contributing

Issues and pull requests are welcome.

## Setting up

- Node from `.nvmrc` (22; CI also runs 24), Terraform 1.11 or later for `terraform test` (1.7 runs
  all but `created_secret.tftest.hcl`), Docker for the end-to-end test, and optionally tflint and
  terraform-docs.
- `npm ci` installs the dependencies and the git hooks (lefthook).

## Checks

```sh
npm run verify     # Biome, tsc, unit tests, bats, and a reproducible zip
scripts/e2e.sh     # the sampler against a real Prometheus remote-write receiver
terraform init -backend=false && terraform test
terraform fmt -recursive
```

CI runs them on Node 22 and 24. For Terraform: `terraform validate` on 1.5.7 and the latest,
`terraform test` on 1.7.5 (the first with mock providers), 1.11 (plan-time overrides) and the
latest, each against the AWS provider's 5.77 floor, the newest 5.x and the newest 6.x. The examples
are validated and linted against the runner module versions they pin, and the workflows by
actionlint and zizmor.

## Conventions

- TypeScript, run directly by Node (type stripping), bundled by esbuild only for the release.
- Tests sit next to the code they test (`*.test.ts`, `*.bats`, `main.tftest.hcl`).
- Every metric is defined once, in `src/model/catalogue.ts`; run `npm run docs:metrics` after
  changing it. Names start `github_aws_runners_`, gauges never end in `_total`, and runner names or
  instance ids are never labels.
- A source that fails leaves its series out; never report an unknown as zero.
- The Terraform module hands the Lambda one JSON document, `CONFIG` (`config.tf`, read by
  `src/config/parse.ts`). A change to it changes `src/test/config.v1.json` too: `main.tftest.hcl`
  checks the module renders it and `src/config/contract.test.ts` that the Lambda reads it.
- What would make the Lambda reject `CONFIG` is refused by the module first, as a variable
  validation or a precondition on the function, never left to fail at runtime.
- Keep the Lambda's dependencies to the AWS SDK.

## Releasing

1. Bump `version` in `package.json` on `main`.
2. Tag the commit `vX.Y.Z` and push the tag. The release workflow runs CI, builds the zip, waits
   for a reviewer to approve the `release` environment, then checks, attests and publishes it.
   Re-running a failed publish finishes the same release.

There are deliberately no floating `vX` / `vX.Y` tags. Consumers pin an exact version (and
`modules/download-lambda` refuses anything else), and a workflow that never writes tags needs
only the built-in token, with no automation bypassing the tag ruleset.

### Repository settings releases depend on

These are settings, not files, so they are listed here for whoever administers the repository:

- **Environment `release`** (Settings > Environments): required reviewers (at least one person other
  than whoever pushes tags), "Prevent self-review" on, and deployment limited to tags matching
  `v*`. The publish job waits on it.
- **Tag ruleset for `v*`** (Settings > Rules > Rulesets, target: tags): restrict creation, update
  and deletion, with bypass only for the maintainers who push release tags. Do not add GitHub
  Actions as a bypass: no workflow needs to write a tag.
- **Immutable releases** (Settings > General > Releases): on, so a published release's assets and
  tag cannot be replaced. Releases are created as drafts and published once complete, which this
  needs.
- **Branch ruleset for `main`**: pull requests with one approving review, and the `ci-ok` check
  required (it fails if any CI job does not succeed; `scripts/ci.test.ts` keeps every job in it).
