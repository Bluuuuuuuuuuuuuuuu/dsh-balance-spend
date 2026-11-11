
# Publishing notes

## Where it stands (2026-11-11)

`npm publish` with a bypass-2FA granular token no longer publishes directly. npm is
retiring direct publish for those tokens (target January 2027) and now **stages** the
version instead: the registry keeps a placeholder `dsh-balance-spend@0.0.0-stage`
("Temporary package placeholder for staged publishing") and the real `1.0.0` tarball
waits in the stage queue until a maintainer approves it with **interactive 2FA**.

Observed on this account (`ren466538539`, `tfa: false`):

    409 Conflict - PUT https://registry.npmjs.org/dsh-balance-spend
        - Cannot publish over previously staged version "1.0.0"
    npm stage list  -> No staged packages found      (needs an authenticated 2FA session)
    npm profile get -> 403                           (granular tokens cannot read the profile)

Background: [Staged publishing](https://docs.npmjs.com/staged-publishing),
[stage-only tokens](https://github.blog/changelog/2026-09-18-stage-only-npm-tokens-for-safer-automation/),
[bypass-2FA restriction](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/).

## What unblocks it

2FA must be enabled once on the account — a token cannot approve its own stage.

1. https://www.npmjs.com/settings/ren466538539/profile → Two-factor authentication → Enable
2. In a normal terminal: `npm login` (browser) — this session carries 2FA
3. Approve the staged release: `npm stage list` → `npm stage approve <stage-id>`
   (or publish the same content again with a code: bump to `1.0.1`, then
   `npm publish --otp=<code>`)
4. Revoke the stage/publish token used for the staged attempt; it keeps package write
   rights (dist-tags, deprecate).

## GitHub

    gh auth login --hostname github.com --git-protocol https --web
    gh repo create dsh-balance-spend --public --source . --push

`gh` lives at `C:\Program Files\GitHub CLI\gh.exe` (installed with winget); a shell
opened before the install does not have it on PATH.

Then PR the market listing to `awesome-dsh-plugin/awesome-dsh-plugin`: add one line
under "Usage & Billing", keeping the section alphabetical:

    - [<owner>/dsh-balance-spend](https://github.com/<owner>/dsh-balance-spend) - Account balance beside the Harness mark, per-session spend, and a sidebar-foot list of what running sessions are spending, priced from each session log's token usage.
