# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

See our security policy and contact details at:
**https://retyc.com/.well-known/security.txt**

## Known limitations

- Authentication tokens (access token + refresh token) are stored in `browser.storage.local`,
  which is not encrypted at rest. Anyone with access to the Thunderbird profile directory
  can read them. Protect your OS user account accordingly.
