# Contributing

Issues and pull requests are welcome.

## Setting up

- Node from `.nvmrc`, Terraform 1.11 or later for `terraform test` (1.7 runs all but
  `created_secret.tftest.hcl`), Docker for the end-to-end test, and optionally tflint and
  terraform-docs.
- `npm ci` installs the dependencies and the git hooks (lefthook).

## Checks

```sh
npm run verify     # Biome, tsc, unit tests, bats, and a reproducible zip
scripts/e2e.sh     # the sampler against a real Prometheus remote-write receiver
terraform init -backend=false && terraform test
terraform fmt -recursive
```

CI runs them across the versions in the README's [compatibility table](README.md#compatibility),
validates and lints the examples against the runner module versions they pin, and lints the
workflows with actionlint and zizmor.

## Conventions

- TypeScript, run directly by Node (type stripping), bundled by esbuild only for the release.
- Tests sit next to the code they test (`*.test.ts`, `*.bats`, `main.tftest.hcl`).
- Every metric is defined once, in `src/model/catalogue.ts`; run `npm run docs:metrics` after
  changing it. Names start `github_aws_runners_`, gauges never end in `_total`, and runner names or
  instance ids are never labels.
- A source that fails leaves its series out; never report an unknown as zero.
- `src/domain` and `src/model` are plain logic: the domain imports only itself, the model only
  the domain and itself (`src/layers.test.ts`). Configuration, SDKs and I/O stay in the adapters.
- The Terraform module hands the Lambda one JSON document, `CONFIG` (`config.tf`, read by
  `src/config/parse.ts`). A change to it changes the `src/test/config.v1.*.json` documents too:
  `main.tftest.hcl` renders each, and `src/config/contract.test.ts` checks what the Lambda takes
  each to mean, and that every one has its terraform test run.
- The Lambda requires every field the module renders, so a module and zip of different versions
  can disagree: each release's zip goes with that release's module. An older Lambda ignores a
  field it does not know, so add a new field to the module a release before the Lambda requires
  it; bump `version` for a change an older Lambda would misread, so the mismatch is named.
- What would make the Lambda reject `CONFIG` is refused by the module first, never left to fail at
  runtime: as a variable's validation when the rule is about that variable alone, otherwise as an
  entry of `local.rejected` (`validation.tf`) and a precondition on what it protects. The two rules
  with no offenders to name, no runner configs at all and a timeout too short, are preconditions
  of their own. The patterns, limits and reserved headers both sides use are in
  `src/config/rules.ts`, label names in `src/domain/labels.ts`, and `src/config/parity.test.ts`
  fails when the module's copy differs.
- Each refusal has a test. One of `local.rejected` asserts, through `local.refused`, that its rule
  alone refused; one of a variable's validations breaks only that rule, since Terraform names just
  the variable.
- Keep the Lambda's dependencies to the AWS SDK.

## Releasing

1. Bump `version` in `package.json` on `main`.
2. Tag the commit `vX.Y.Z` and push the tag. The release workflow runs CI, builds the zip, waits
   for a reviewer to approve the `release` environment, then checks, attests and publishes it.
   Re-running a failed publish replaces its draft with the same build.

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
