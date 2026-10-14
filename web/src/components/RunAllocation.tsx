import { api } from "../api";
import { useAction } from "../hooks";
import { allocationMessage } from "../labels";
import { Button } from "./ui";

/** Matches every waiting booking to a free car now, instead of waiting for the next automatic sweep. */
export function RunAllocationButton({ onDone, variant = "secondary" }: { onDone?: () => void; variant?: "primary" | "secondary" }) {
  const action = useAction();
  const run = async () => {
    const res = await action.run(() => api.runAllocation(), {
      success: (r) => (r.allocated ? `Allocation run complete. ${allocationMessage(r.allocations)}` : "Allocation run complete. No waiting booking could be matched to a free car."),
    });
    if (res) onDone?.();
  };
  return (
    <Button variant={variant} icon="refresh" busy={action.busy} onClick={() => void run()}>
      Run allocation now
    </Button>
  );
}
