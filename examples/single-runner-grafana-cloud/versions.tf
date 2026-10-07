terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # terraform-aws-github-runner v6 pins aws ~> 5.77; this module works on it too.
      version = "~> 5.77"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}
