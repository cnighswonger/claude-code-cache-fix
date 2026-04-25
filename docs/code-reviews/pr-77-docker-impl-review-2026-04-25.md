# Review: Docker image + GH Actions publish workflow

Date: 2026-04-25
Reviewed: `Dockerfile`, `.dockerignore`, `.github/workflows/docker-publish.yml`, `README.md`
Label applied: `approved-by-codex-agent`

## What Is Correct

- The container build is intentionally narrow. The Dockerfile copies only `package.json`, optional `package-lock.json`, and `proxy/`, so runtime correctness does not depend on most of the repo and `.dockerignore` is a context-size optimization rather than a correctness boundary.
- `npm install --omit=dev --ignore-scripts` is appropriate here. `postinstall.js` only prints the preload security notice and does not generate runtime assets or mutate the proxy package layout, so skipping it in-container is safe.
- Running as the built-in `node` user is the right default. The image avoids root at runtime without adding complexity, and local smoke testing confirmed the container serves `/health` correctly.
- `CACHE_FIX_PROXY_BIND=0.0.0.0` is the correct container default. Binding `127.0.0.1` inside the container would break normal `-p host:container` usage. The exposure boundary belongs at Docker networking / host publish configuration, not at the process bind address.
- The workflow permissions are minimal (`contents: read`, `packages: write`) and the multi-arch Buildx/QEMU setup is standard and reasonable for a release-only publish path.
- The workflow already includes `workflow_dispatch`, so the "first publish after merge" concern is covered operationally even though tag-push workflows only fire for newly pushed tags.

## Blockers

None.

## What Needs Attention

### Nits

- `README.md`: the `host.docker.internal` example is not universally portable on plain Linux Docker Engine. It works reliably on Docker Desktop, but Linux users may still need `--add-host=host.docker.internal:host-gateway` or an explicit bridge/gateway address. The example is directionally right, but it should be qualified to avoid copy-paste failure.
- `.github/workflows/docker-publish.yml`: `type=raw,value=latest,enable=startsWith(github.ref, 'refs/tags/v')` makes every future `v*` tag authoritative for `latest`, regardless of major line. That is fine if "latest means newest tagged release across all majors" is the intended policy, but it should be treated as an explicit policy decision rather than an incidental default.

### Nice-to-haves

- `Dockerfile`: `node:22-alpine` is a defensible base here because the image intentionally keeps operator ergonomics (`curl` health probe, shell access, easy debugging). A smaller runtime-only or distroless variant could reduce size further, but I would not trade away debuggability for this proxy at the current maturity level.
- `Dockerfile`: the healthcheck is safe enough in practice because the interpolated port value is quoted and the runtime parser falls back to `9801` for invalid `CACHE_FIX_PROXY_PORT` values. Still, an exec-form healthcheck would remove the shell entirely and make the intent more obviously robust.

## Recommendations

- Add one sentence to the Docker README subsection noting the Linux `host.docker.internal` caveat and the `--add-host=host.docker.internal:host-gateway` workaround.
- Decide whether `latest` should always track the newest semver tag across all major lines. If yes, leave the workflow as-is and document that policy. If no, gate `latest` more tightly at release time.

## Bottom Line

APPROVE. The implementation is appropriately scoped, the security posture is sound for a small operator-facing proxy image, and the CI publish workflow follows a standard low-risk pattern. The issues I found are documentation/policy clarifications, not release blockers.

Codex Review Agent
