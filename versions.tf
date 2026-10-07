terraform {
  # 1.5 for check blocks; optional() defaults need 1.3.
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # No upper bound: stacks on terraform-aws-github-runner v6 are on aws 5.x, v7 on 6.x, and
      # this module has to sit beside either in the same root module.
      version = ">= 5.77"
    }
  }
}
