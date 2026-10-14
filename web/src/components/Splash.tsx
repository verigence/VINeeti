import { PRODUCT } from "../product";

/** The splash screen: the product's own logo with its maker beneath, on every size of screen, while the app opens. */
export function Splash() {
  return (
    <div className="splash" role="status" aria-label={`${PRODUCT} is opening`}>
      <img src="/brand/wordmark-light.png" alt={PRODUCT} className="splash-image" />
      <img src="/brand/lockup-light.png" alt="A product by JBR Consulting" className="splash-maker" />
    </div>
  );
}
