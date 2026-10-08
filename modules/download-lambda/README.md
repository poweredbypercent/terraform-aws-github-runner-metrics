# download-lambda

Downloads an exact release of the github-runner-metrics Lambda and verifies it before Terraform uses
it, against a trust anchor you choose - the SHA-256 you pin from the release notes, the release's
build-provenance attestation (`verify_attestation = true`: signed by its release workflow, for that
tag, on a GitHub-hosted runner), or both; one is required - and against the release's own checksum
file. A zip that fails a check never reaches its output path.

```hcl
module "metrics_lambda" {
  source      = "github.com/poweredbypercent/terraform-aws-github-runner-metrics//modules/download-lambda?ref=v0.1.0"
  release_tag = "v0.1.0"
  sha256      = "<from the release notes>"
}

# lambda_zip = { path = module.metrics_lambda.path, source_code_hash = module.metrics_lambda.source_code_hash }
```

It runs a shell script on every plan where Terraform runs (bash, curl, sha256sum or shasum, and gh
for attestations): a zip already on disk is verified again rather than trusted, and downloaded only
when it is missing or fails. Two consequences:

- Plan and apply must run in the same working directory. A plan saved with `-out` and applied
  elsewhere (another runner or agent) has no zip there, and the zip is read again at apply.
- Every plan needs those tools, `terraform destroy` included.

For pipelines where either is a problem, copy the verified zip to S3 instead and use the module's
`lambda_zip.s3`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| terraform | >= 1.5 |
| external | >= 2.2 |

## Providers

| Name | Version |
|------|---------|
| external | >= 2.2 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [external_external.zip](https://registry.terraform.io/providers/hashicorp/external/latest/docs/data-sources/external) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| release\_tag | The exact release to download, e.g. v1.2.3. Floating tags (v1) are refused: the bytes behind them change. | `string` | n/a | yes |
| output\_dir | Where to put the zip. Defaults to a directory beside this module (inside .terraform/modules when the module is fetched, so a fresh init downloads it again). | `string` | `null` | no |
| repository | The GitHub repository releases are downloaded from. | `string` | `"poweredbypercent/terraform-aws-github-runner-metrics"` | no |
| sha256 | The zip's expected SHA-256 (hex), from the release notes: the trust anchor. Set this, verify\_attestation, or both. | `string` | `null` | no |
| verify\_attestation | Verify the release's build-provenance attestation with `gh attestation verify`: signed by the repository's release workflow, for this tag, on a GitHub-hosted runner. Needs the gh CLI, authenticated, wherever Terraform plans. | `bool` | `false` | no |

## Outputs

| Name | Description |
|------|-------------|
| path | The verified zip, for lambda\_zip.path. |
| source\_code\_hash | The zip's base64 SHA-256, for lambda\_zip.source\_code\_hash. |
<!-- END_TF_DOCS -->
