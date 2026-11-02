# VINeeti — working notes for this repository

## Release policy (binding)

See `docs/RELEASE_POLICY.md`. In short:

- Merging to `main` deploys to the **test build** only (`verigence-vineeti-hyundai`, vineeti.jbrconsulting.in).
- **Aditya Motors** (`verigence-vineeti`, adityamotors.mh.jbrconsulting.in) is live. It is updated only by
  running "Deploy to Cloudflare" by hand with target `aditya-motors` and "checked on the test build"
  ticked, after the change has been checked on the test build. The workflow refuses a commit that has
  not passed on the test build.
- Do not promote to Aditya Motors on your own initiative: say what is on the test build and wait for
  the product owner to confirm it has been checked there.
- Deploy through GitHub Actions only. Never `wrangler deploy` by hand.
- Baselines (tag + `baseline/<tag>` branch + release) are made with the "Baseline a release" workflow
  and never moved. Go-live baseline: `aditya-mahindra-go-live-2026-11-02` (commit `04f61d7`).
