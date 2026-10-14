// "Today's board" is one place in the menu and three different screens, because three different people
// open it and they are not looking for the same thing.
//
// A sales lead wants the money owed on cars already held and who to ring about it. A Dealer Principal
// wants what is blocked and whether the place is turning over. A Business Head wants the shape of the
// operation: what is piling up, what sells, who is waiting. Giving all three to all three would be four
// screens of scrolling each, and the part that mattered would be somewhere in the middle of it.
//
// So the board is chosen by the job, not by a tab the person has to find. Nobody has to learn which of
// three boards is theirs, and nothing on one board is repeated on another.

import { useSession } from "../session";
import { CeoBoard } from "./Ceo";
import { DealerPrincipalBoard } from "./DealerPrincipal";
import { TeamLeadBoard } from "./TeamLead";

export function BoardPage() {
  const { me } = useSession();
  if (me.user.role === "BUSINESS_HEAD") return <CeoBoard />;
  if (me.user.role === "DEALER_PRINCIPAL") return <DealerPrincipalBoard />;
  return <TeamLeadBoard />;
}
