# Release policy

Adopted 2 Nov 2026, the day Aditya Motors (Mahindra) went live.

## The rule

A change is checked on the test build before it is deployed to Aditya Motors.

| Build | Worker | Address | Updated |
|---|---|---|---|
| Test build | `verigence-vineeti-hyundai` | vineeti.jbrconsulting.in | On every merge to `main`, automatically |
| Aditya Motors (live) | `verigence-vineeti` | adityamotors.mh.jbrconsulting.in | Only by promotion, by hand |

Both run the same code from the same commit, each with its own database, files and secrets.

## How a change reaches Aditya Motors

1. The change is merged to `main`. GitHub Actions ("Deploy to Cloudflare") runs the type check and the
   tests, deploys to the **test build only**, and runs the post-deploy checks there.
2. The change is checked on the test build (vineeti.jbrconsulting.in).
3. Once it has been checked and found right, it is promoted: "Deploy to Cloudflare" is started by hand
   from `main` with target **aditya-motors** and the box "checked on the test build" ticked.

The promotion run refuses to deploy, and changes nothing, when:
- the box is not ticked, or
- that exact commit has not been deployed to the test build and passed its post-deploy checks there.

Deployment is through GitHub Actions only. Nothing is deployed by hand.

## Baselines

A version that goes live is baselined with the "Baseline a release" workflow: an annotated tag, a
branch `baseline/<tag>` and a GitHub release, all on the same commit. A baseline is never moved.

| Tag | Title | Commit |
|---|---|---|
| `aditya-mahindra-go-live-2026-11-02` | Aditya Mahindra Go-Live 02 Nov 2026 | `04f61d7` |

To put Aditya Motors back on a baseline, start "Deploy to Cloudflare" from the tag with target
**aditya-motors**. The baseline passed on the test build when it was made, so the promotion check
lets it through. Database migrations only go forward: going back to an older baseline does not undo
a migration, so a rollback past a schema change needs a look first.
