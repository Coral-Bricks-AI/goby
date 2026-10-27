# Security

## Reporting

Report vulnerabilities privately through GitHub's "Report a vulnerability"
(Security → Advisories) on this repository. Please do not open a public issue
for anything exploitable.

Useful reports name the invariant that breaks. The most important one is in
`docs/trust-model.md`: **the review must never execute code from the pull
request**. Anything that lets a PR cause code execution, exfiltrate the
provider key, or post content the harness did not generate is in scope.

## Supported versions

Pin the action to a reviewed full commit SHA. The action executes that
revision's source without a PyPI install. Security updates require reviewing
and updating the pin in each consumer. A release/tag is not required.

The gate trusts the configured bot logins and GitHub API responses. Protect
workflows and branch rules from untrusted edits; prefer a dedicated GitHub
App identity where other workflows must not impersonate the gate. The gate
is not a proof of the model's review accuracy; see `docs/merge-gate.md`.
