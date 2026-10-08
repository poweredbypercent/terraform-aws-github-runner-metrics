data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  # Read from the region's EC2 endpoint, ec2.<region>.<dns suffix>: the one attribute that neither
  # aws 5.x nor 6.x deprecates. 6.x deprecates `id` and `name` for `region`, which 5.x does not
  # have; use `region` once 5.x support is dropped. The provider always resolves that form; a
  # mocked provider's made-up endpoint is taken as it is, so a consumer's own tests still plan.
  region     = try(regex("^ec2\\.([a-z0-9-]+)\\.", data.aws_region.current.endpoint)[0], data.aws_region.current.endpoint)
  account    = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix
}
