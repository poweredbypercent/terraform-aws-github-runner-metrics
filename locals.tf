data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  # The region's id is its name on aws 5.x and 6.x alike. 6.x deprecates it (and `name`) in favour
  # of `region`, which 5.x does not have; switch to `region` once 5.x support is dropped.
  region     = data.aws_region.current.id
  account    = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix
}
