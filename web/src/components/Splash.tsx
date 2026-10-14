import { PRODUCT } from "../product";

/** The splash screen: the product mark with its maker, on every size of screen, while the app opens. */
export function Splash() {
  return (
    <div className="splash" role="status" aria-label={`${PRODUCT} is opening`}>
      <img src="/brand/lockup.png" alt={`${PRODUCT}. Fair allocation, smarter inventory. A product by JBR Consulting`} className="splash-image" />
    </div>
  );
}
