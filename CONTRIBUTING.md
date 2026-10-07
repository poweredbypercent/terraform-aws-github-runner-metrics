# Contributing

Issues and pull requests are welcome.

## Setting up

- Node from `.nvmrc` (22; CI also runs 24), Terraform 1.11 or later for `terraform test`, Docker for
  the end-to-end test, and optionally tflint and terraform-docs.
- `npm ci` installs the dependencies and the git hooks (lefthook).

## Checks

```sh
npm run verify     # Biome, tsc, unit tests, bats, and a reproducible zip
scripts/e2e.sh     # the sampler against a real Prometheus remote-write receiver
terraform init -backend=false && terraform test
terraform fmt -recursive
```

CI runs them on Node 22 and 24. For Terraform: `terraform validate` on 1.5.7 and the latest,
`terraform test` on 1.11 (its plan-time overrides need it) and the latest, each against the AWS
provider's 5.77 floor, the newest 5.x and the newest 6.x. The examples are validated and linted
against the runner module versions they pin.

## Conventions

- TypeScript, run directly by Node (type stripping), bundled by esbuild only for the release.
- Tests sit next to the code they test (`*.test.ts`, `*.bats`, `main.tftest.hcl`).
- Every metric is defined once, in `src/model/catalogue.ts`; run `npm run docs:metrics` after
  changing it. Names start `github_aws_runners_`, gauges never end in `_total`, and runner names or
  instance ids are never labels.
- A source that fails leaves its series out; never report an unknown as zero.
- Keep the Lambda's dependencies to the AWS SDK.

## Releasing

1. Bump `version` in `package.json` on `main`.
2. Tag the commit `vX.Y.Z` and push the tag. The release workflow runs CI, builds and attests the
   zip, waits for a reviewer to approve the `release` environment, then publishes the release and
   moves the `vX` and `vX.Y` tags - forward only, so a backport release leaves them where they are.

### Repository settings releases depend on

These are settings, not files, so they are listed here for whoever administers the repository:

- **Environment `release`** (Settings > Environments): required reviewers (at least one person other
  than whoever pushes tags), "Prevent self-review" on, and deployment limited to tags matching
  `v*`. The publish job waits on it.
- **Tag ruleset for `v*`** (Settings > Rules > Rulesets, target: tags): restrict creation, update
  and deletion to maintainers, with a bypass for GitHub Actions so the workflow can move the
  floating `vX` and `vX.Y` tags.
- **Immutable releases** (Settings > General > Releases): on, so a published release's assets and
  tag cannot be replaced. Releases are created as drafts and published once complete, which this
  needs.
- **Branch ruleset for `main`**: pull requests with one approving review, and the `ci-ok` check
  required (it fails if any CI job does not succeed).
