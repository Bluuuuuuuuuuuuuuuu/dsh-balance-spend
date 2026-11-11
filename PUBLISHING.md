
# Publishing notes

## State (2026-11-11)

- npm: `dsh-balance-spend@1.0.0` is live on the public registry (`latest`); the
  `0.0.0-stage` placeholder npm creates for a staged publish is deprecated.
- GitHub: public repository, `dsh-plugin` topic set.
- Market: one-file PR to `awesome-dsh-plugin/awesome-dsh-plugin`
  (`data/plugins/<owner>__<repo>.yml`, `category: usage`). It waits for the
  repository-age gate (>= 1 day old), which re-runs by itself.

## npm staged publishing (what bit us)

A granular token with "bypass 2FA" no longer publishes directly: npm stages the
version and answers

    409 Conflict - PUT https://registry.npmjs.org/<package>
        - Cannot publish over previously staged version "<version>"

while the registry shows only a `0.0.0-stage` placeholder. Approval needs an
interactive 2FA session — a token cannot approve its own stage:

1. Enable 2FA on the npm account (Settings -> Two-factor authentication).
2. In a normal terminal: `npm login` (browser) so the session carries the OTP.
3. `npm stage list` -> `npm stage approve <stage-id>`, or publish a new version
   with `npm publish --otp=<code>`.
4. Revoke the token used for the staged attempt afterwards; it keeps package
   write rights (dist-tags, deprecate).

## GitHub + market listing

    gh auth login --hostname github.com --git-protocol https --web
    gh repo create <repo> --public --source . --push

The submission is ONE file, `data/plugins/<owner>__<repo>.yml`:

    url: https://github.com/<owner>/<repo>
    name: <owner>/<repo>
    category: usage
    description:
      en: '...'
      zh: '...'

Open the PR against `awesome-dsh-plugin/awesome-dsh-plugin`; do not edit the
generated READMEs. CI runs `PR check` (lint, README parity, site build) and then
`Submission gate` (dsh.bundle manifest, repository age, commit count). A brand-new
repository fails the age gate and is re-checked automatically by `regate`; no
resubmit is needed.
