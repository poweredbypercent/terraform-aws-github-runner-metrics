# download-lambda

Downloads an exact release of the github-runner-metrics Lambda and verifies it before Terraform uses
it: against the SHA-256 you pin (the trust anchor), and against the release's own checksum file.
With `verify_attestation = true` it also checks the build-provenance attestation with
`gh attestation verify`. A zip that fails a check never reaches its output path.

```hcl
module "metrics_lambda" {
  source      = "github.com/poweredbypercent/terraform-aws-github-runner-metrics//modules/download-lambda?ref=v0.1.0"
  release_tag = "v0.1.0"
  sha256      = "<from the release notes>"
}

# lambda_zip = { path = module.metrics_lambda.path, source_code_hash = module.metrics_lambda.source_code_hash }
```

It runs a shell script where Terraform runs (bash, curl, and sha256sum or shasum), and downloads
again on a fresh checkout. For locked-down pipelines, copy the verified zip to S3 instead and use the
module's `lambda_zip.s3`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| terraform | >= 1.5 |
| local | >= 2.2 |

## Providers

| Name | Version |
|------|---------|
| local | >= 2.2 |
| terraform | n/a |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [terraform_data.download](https://registry.terraform.io/providers/hashicorp/terraform/latest/docs/resources/data) | resource |
| [local_file.zip](https://registry.terraform.io/providers/hashicorp/local/latest/docs/data-sources/file) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| release\_tag | The exact release to download, e.g. v1.2.3. Floating tags (v1) are refused: the bytes behind them change. | `string` | n/a | yes |
| output\_dir | Where to put the zip. Defaults to a directory beside this module. | `string` | `null` | no |
| repository | The GitHub repository releases are downloaded from. | `string` | `"poweredbypercent/terraform-aws-github-runner-metrics"` | no |
| sha256 | The zip's expected SHA-256 (hex), from the release notes. Recommended: it is the trust anchor; without it the release's own checksum file is used, which catches corruption but not a tampered release. | `string` | `null` | no |
| verify\_attestation | Also verify the release's build-provenance attestation with `gh attestation verify` (needs the gh CLI, authenticated). | `bool` | `false` | no |

## Outputs

| Name | Description |
|------|-------------|
| path | The verified zip, for lambda\_zip.path. |
| source\_code\_hash | The zip's base64 SHA-256, for lambda\_zip.source\_code\_hash. |
<!-- END_TF_DOCS -->
