# Releasing Yibra Desktop

How a new version gets from your PC onto everyone's machine.

## How auto-update works

1. A version tag (e.g. `v0.3.1`) is pushed to GitHub.
2. The **Release** GitHub Action (`.github/workflows/release.yml`) builds the installer on a Windows runner (electron-builder, build only), then the `gh` CLI uploads it to a **draft** release containing:
   - `Yibra-Setup.exe`: the installer
   - `Yibra-Setup.exe.blockmap`: lets the updater download only the changed chunks
   - `latest.yml`: the manifest installed apps read to see what's newest

   The Action then checks that all three files are attached, and only then publishes the draft. A missing file turns the job red, so a half-uploaded release never goes live.
3. Every installed Yibra checks `latest.yml` **10 seconds after launch and every 4 hours**. Updates download quietly in the background.
4. When the download is done, a Windows toast and a tray item say **"Restart to update (vX)"**.
   - Clicking either one restarts Yibra on the new version.
   - Ignoring them is fine too: the update installs the next time Yibra properly quits (tray > Quit, or a reboot). Hiding to the tray doesn't count as quitting.
5. The tray menu also has **Check for updates** for impatient squad leaders.

The repo is **public**, so the app needs no token to read releases. There are no secrets in this repo, and none should ever be added. Anything secret belongs in the Laravel app on the VPS.

## Cutting a release (the normal way)

```powershell
git add .
git commit -m "Whatever changed"
pnpm version patch          # 0.3.0 -> 0.3.1, commits and tags v0.3.1
git push --follow-tags      # pushes commit + tag, the Action does the rest
```

- Use `pnpm version minor` for bigger releases (0.3.x to 0.4.0).
- Watch the build under the repo's **Actions** tab. It takes about 3-5 minutes.
- When it goes green, the release is live and every client updates within 4 hours, or straight away on next launch.

The Action refuses to build if the tag and `package.json` version don't match, which is why `pnpm version` is the way to bump.

## Download link for the website

Because the installer has a fixed name, this link always points to the newest version:

```
https://github.com/Rayza73/yibra-desktop/releases/latest/download/Yibra-Setup.exe
```

## Local builds (testing only)

```powershell
pnpm pack     # unpacked test build: dist\win-unpacked\Yibra.exe
pnpm dist     # installer in dist\, NOT published
```

Don't use `pnpm release`: it's electron-builder's own uploader, which has the race bug described under Gotchas. Releases go through the Action only.

## Testing the update loop

1. Install a released version (e.g. v0.3.2) from the Releases page.
2. Cut the next release (v0.3.3) as above.
3. Launch the installed v0.3.2 and wait ~10 seconds, or use tray > **Check for updates**.
4. A toast should say v0.3.3 is ready. Click it, and Yibra restarts as v0.3.3 (check the version label at the top of the tray menu).

## Gotchas

- **Don't let electron-builder upload (v0.3.0 and v0.3.1 were broken).** With `--publish always`, electron-builder 26.15.3 started two GitHub publishers at once. Both saw "release doesn't exist" and both created one, so the blockmap landed on one release and the exe on another. The build step then exited before the 111 MB exe upload finished, and `latest.yml` never got uploaded. v0.3.0 still went green with only the blockmap. v0.3.1 was caught by the new verify step and stayed a draft.
  - It was not immutable releases, which is off in the repo settings.
  - Fix (v0.3.2): electron-builder now only builds (`pnpm run dist`, `--publish never`), and `gh release create` uploads all three files to one draft. The verify step then checks them before publishing.
  - The `publish` block in `package.json` is still needed: it's what generates `latest.yml` and bakes the update feed (`app-update.yml`) into the app.
- **Updates only run in the installed app.** `pnpm start` skips the updater entirely because there's no update feed in dev.
- **Never delete a published release's `latest.yml`.** Clients would get confused. To pull a bad release, publish a newer fixed one instead.
- **Don't reuse a version number.** Bump it, always.
- **SmartScreen** still warns on first install because the exe isn't code-signed. Auto-updates aren't affected because they don't go through SmartScreen.
- **The v0.2.0 installer has no updater**, so anyone on v0.2.0 must install v0.3.2+ manually once (v0.3.0 and v0.3.1 were broken releases, so skip them). After that it's automatic.
- **Lockfile:** CI runs `pnpm install --frozen-lockfile`, so after changing dependencies, commit the updated `pnpm-lock.yaml` or the build fails.
