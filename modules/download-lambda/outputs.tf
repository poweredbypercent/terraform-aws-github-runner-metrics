output "path" {
  description = "The verified zip, for lambda_zip.path."
  value       = data.external.zip.result.path
}

output "source_code_hash" {
  description = "The zip's base64 SHA-256, for lambda_zip.source_code_hash."
  value       = filebase64sha256(data.external.zip.result.path)
}
