// Thin bars that tell the user about the app itself: no connection, or a new version ready.

import { applyUpdate, useOnline, usePwa } from "../pwa";
import { Icon } from "./icons";

export function StatusBars() {
  const online = useOnline();
  const { updateWaiting } = usePwa();
  if (online && !updateWaiting) return null;
  return (
    <div className="status-bars">
      {!online && (
        <div className="status-bar status-offline" role="status">
          <Icon name="offline" size={16} />
          <span>You are offline. Showing nothing new until the connection is back.</span>
        </div>
      )}
      {updateWaiting && (
        <div className="status-bar status-update" role="status">
          <Icon name="refresh" size={16} />
          <span>Update available</span>
          <button type="button" className="status-action" onClick={applyUpdate}>
            Reload
          </button>
        </div>
      )}
    </div>
  );
}
