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

CI runs all of these on every supported Node version, Terraform from 1.5 to the latest, and both AWS
provider majors.

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
   zip, publishes the release, and moves the `vX` and `vX.Y` tags.
