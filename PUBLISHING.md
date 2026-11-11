
# Publishing notes

npm requires 2FA (or a granular token with "bypass 2FA") to publish. The account
`ren466538539` currently has `tfa: false`, so `npm publish` answers:

    403 Two-factor authentication or granular access token with bypass 2fa enabled is required

## Path A — enable 2FA, publish with a one-time code

1. https://www.npmjs.com/settings/ren466538539/profile → Two-factor authentication → Enable
2. Scan the QR with any authenticator app; the 6-digit npm code lives there (30 s rotation)
3. `npm publish --otp=<code>`

## Path B — granular token (no code per publish)

1. Enable 2FA as above (npm requires it before a bypass token can be created)
2. https://www.npmjs.com/settings/ren466538539/tokens → Generate New Token → Granular
   - Packages: read and write (all, or just `dsh-balance-spend`)
   - "Bypass 2FA" checked
3. `NPM_TOKEN=<token> npm publish` (or `npm config set //registry.npmjs.org/:_authToken <token>`)
4. Revoke the token afterwards.

## GitHub

    gh auth login --hostname github.com --git-protocol https --web
    gh repo create dsh-balance-spend --public --source . --push
    gh repo view --web

Then PR the market listing to `awesome-dsh-plugin/awesome-dsh-plugin`: add one line
under "Usage & Billing":

    - [<owner>/dsh-balance-spend](https://github.com/<owner>/dsh-balance-spend) - Account balance beside the Harness mark, per-session spend and a running-session spend list for DeepSeek Harness.