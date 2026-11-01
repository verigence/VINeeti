// Installing VINeeti on a phone.
//
// The app is not on the Play Store, so it is installed from a file. That file is handed out from
// here, to somebody who has already signed in, rather than from a public address: an APK sitting on
// an address anybody could guess is a copy of the dealership's app anybody could take.
//
// Android will warn about installing a file from outside the Play Store. The warning is normal and
// the page says so plainly, because a person who is not told to expect it either stops, or learns to
// click through warnings — and the second is worse than the first.

import { api } from "../api";
import { Async, Card, Empty, KeyValues, Notice, PageHeader } from "../components/ui";
import { fmtDateTime } from "../format";
import { useLoad } from "../hooks";
import { useSession } from "../session";

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

export function GetTheAppPage() {
  const { me } = useSession();
  const load = useLoad(() => api.appBuild(), "app-build");
  const appName = me.app_name ?? "VINeeti";

  return (
    <>
      <PageHeader title={`${appName} on your phone`} subtitle="The same system as on this screen, as an app on the home screen. Sign in once and it stays signed in." />
      <Async load={load}>
        {(d) =>
          !d.build ? (
            <Card>
              <Empty
                title="No build is on offer yet"
                hint="Once the Android build has been run and published, it appears here for everybody at the dealership to install."
              />
            </Card>
          ) : (
            <>
              <Card
                title="Download"
                note="Open this page on the phone you want the app on. Downloading it here, on a computer, gives you a file the phone cannot use."
              >
                <p>
                  <a className="btn btn-primary" href="/api/app/download" download>
                    Download the app
                  </a>
                </p>
                <KeyValues
                  columns={2}
                  items={[
                    ["Version", d.build.version],
                    ["Size", megabytes(d.build.size)],
                    ["Built", d.build.built_at ? fmtDateTime(d.build.built_at) : "Not recorded"],
                    d.build.host ? ["Opens", d.build.host] : null,
                  ]}
                />
              </Card>

              <Card title="Installing it">
                <ol className="howto">
                  <li>
                    <span className="strong">Open the downloaded file.</span> It is in the phone's Downloads. Tapping it starts the installer.
                  </li>
                  <li>
                    <span className="strong">Allow this one installation.</span> Android asks whether to allow installing apps from the browser,
                    because this app does not come from the Play Store. Say yes; it applies to this one installation.
                  </li>
                  <li>
                    <span className="strong">Install, then open it.</span> The app appears on the home screen with the rest.
                  </li>
                  <li>
                    <span className="strong">Sign in as you do here.</span> Your dealership code, your mobile number and your password. It stays
                    signed in afterwards.
                  </li>
                </ol>
              </Card>

              <Notice tone="info">
                The app is the same system as this website, so there is nothing new to learn and nothing extra to keep up to date. A newer version is
                offered on this page when one is built; installing it over the old one keeps you signed in.
              </Notice>

              {d.build.sha256 && (
                <Card title="Checking the file" note="Only needed if you want to confirm the file you downloaded is the one that was built.">
                  <p className="muted">SHA-256</p>
                  <p className="mono block">{d.build.sha256}</p>
                </Card>
              )}
            </>
          )
        }
      </Async>
    </>
  );
}
