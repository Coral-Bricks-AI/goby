# Post-merge scanning on a self-hosted runner

Same image, same workflow, same briefs as the [hosted tier](post-merge-hosted.md). The only
difference: the job runs on a machine you control, inside your network — so a scan can read a
private database or call an internal service.

This is the tier to pick when the defects you care about live where the data is, not in the
pure logic.

## 1. The runner

Install one GitHub Actions runner on a machine that can reach what the scans need:

```sh
mkdir actions-runner && cd actions-runner
curl -fsSL https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz | tar xz
./config.sh --url https://github.com/<org>/<repo> --token <registration token> --labels self-hosted,coral
sudo ./svc.sh install && sudo ./svc.sh start
```

Register it at repository, organization or enterprise level — organization level is what makes
one runner serve every repo you scan.

## 2. The workflow

Copy [`cleaners-post-merge.yml`](../.github/workflows/cleaners-post-merge.yml) into the repo
and set one input:

```yaml
jobs:
  scan:
    uses: ./github/workflows/cleaners-post-merge.yml   # or copy the file and edit runs-on
    with:
      runs-on: "[self-hosted, coral]"
```

`runs-on` takes the same label list you gave `config.sh`.

## 3. The model key and the briefs

Identical to the hosted tier: the key as a repository secret, and `/create-invariants-md` to write
the `INVARIANTS.md` files.

## What you now have

A tool in the image can reach your network, so the cleaner's shell can too. Two consequences:

- Prefer a credential-free shim — a local socket held by root that only permits read-only
  statements — over handing the agent a database password. Any credential in `tool-key-env` is
  logged by name at the top of the scan, so a widened scan is visible in the run log.
- The runner is not a sandbox boundary. If the machine holds something a compromised agent must
  not reach, use a dedicated runner rather than your build box.

## Cost

- The machine: one always-on instance, or an existing build box (scans are a few minutes).
- The model: the price line in the job summary, per scan.

Nothing about the hosted tier's guard rails changes: the agent still gets read-only tools, the
checkout is still root-owned and unwritable, and the token still never reaches its shell.
