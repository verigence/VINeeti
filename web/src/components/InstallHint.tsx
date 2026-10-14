// A one-time suggestion, on a phone, to put the app on the home screen.

import { useState } from "react";
import { PRODUCT } from "../product";
import { isIosSafari, isStandalone, promptInstall, usePhone, usePwa } from "../pwa";
import { Icon } from "./icons";
import { Button } from "./ui";

const KEY = "install-hint-dismissed";

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false; // private browsing: show it, and do not remember
  }
}
function remember() {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Not being able to remember is harmless.
  }
}

export function InstallHint() {
  const phone = usePhone();
  const { canInstall } = usePwa();
  const [dismissed, setDismissed] = useState(wasDismissed);
  const ios = isIosSafari();
  // Nothing to offer inside the installed app, on a wide screen, or in a browser that cannot install.
  if (!phone || dismissed || isStandalone() || (!canInstall && !ios)) return null;

  const dismiss = () => {
    remember();
    setDismissed(true);
  };
  const install = async () => {
    await promptInstall();
    dismiss();
  };

  return (
    <aside className="install-hint" aria-label="Install the app">
      <img src="/icons/icon.svg" alt="" width={44} height={44} />
      <div className="install-text">
        <p className="strong">Add {PRODUCT} to your home screen</p>
        {canInstall ? (
          <p className="muted">It opens full screen, like any other app on your phone.</p>
        ) : (
          <ol className="install-steps">
            <li>
              Tap <Icon name="share" size={16} /> <span className="strong">Share</span> at the bottom of Safari.
            </li>
            <li>
              Choose <span className="strong">Add to Home Screen</span>.
            </li>
          </ol>
        )}
        <div className="install-actions">
          {canInstall && (
            <Button variant="primary" icon="phone" onClick={() => void install()}>
              Install app
            </Button>
          )}
          <Button variant="ghost" onClick={dismiss}>
            {canInstall ? "Not now" : "Got it"}
          </Button>
        </div>
      </div>
    </aside>
  );
}
