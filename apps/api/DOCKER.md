# Docker images

The existing `Dockerfile` and `docker-compose.yml` remain the source-build
deployment. `docker-compose.image.yml` is a standalone alternative using
`ghcr.io/hjinco/synch-api:latest`; do not combine the two files with multiple
`-f` arguments. Both use the same project name, service, and data volume.

See the [deployment guide](https://synch.run/self-hosting-docker/) for setup,
upgrades, and switching an existing installation without replacing its data.
When using the image file directly from this directory, include
`-f docker-compose.image.yml` in every Compose command, including upgrades.
Keep any existing project-name override when switching.

## Publishing

`API CI` calls `.github/workflows/api-image.yml` after its API tests, builds,
and Docker smoke test succeed on `main` in `hjinco/synch`. Pull requests and
forks cannot publish. Changes to the image workflow and `.dockerignore` also
trigger API CI. To publish manually, run **API CI** with **Run workflow** on
`main`; it runs the same checks before publishing.

The workflow uses the repository's `GITHUB_TOKEN` with `packages: write`.
No registry password or personal access token is needed. It builds the existing
Dockerfile for `linux/amd64` and `linux/arm64` and publishes a shared manifest:

- `latest`: advances when the tested commit descends from the already published
  revision. Unrelated commits on `main` do not suppress publishing, and an older
  CI run finishing late cannot replace a newer published revision.
- `sha-<full-commit-SHA>`: a tag identifying the source commit. Re-running a build
  can resolve newer base images, so pin a digest for an exact immutable image.

The commit image is pushed first. While holding the publication concurrency lock,
the workflow reads the revision annotation from the existing `latest` index and
compares Git ancestry. It promotes the new multi-platform index by digest on
first publication, a newer revision, or a rebuild of the same revision. Registry
errors, missing revision metadata, and divergent Git histories fail the promotion
instead of overwriting an image whose ordering cannot be established.

API images are independent of Obsidian plugin release tags.

## First publication

1. Merge the workflow and let **API CI** succeed (or run it manually on `main`).
2. Open the `synch-api` package settings under the `hjinco` GitHub account and
   set **Change visibility → Public**. GHCR packages are private on first
   publication even when the source repository is public. If the package
   already exists, ensure this repository has Actions write access to it.
3. Check anonymous access using an empty Docker credentials directory:

   ```bash
   docker_config="$(mktemp -d)"
   docker --config "$docker_config" pull ghcr.io/hjinco/synch-api:latest
   rm -rf "$docker_config"
   docker buildx imagetools inspect ghcr.io/hjinco/synch-api:latest
   ```

Confirm that both `linux/amd64` and `linux/arm64` are listed before announcing
image availability. Reference: [GitHub Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
