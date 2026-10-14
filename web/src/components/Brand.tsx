// The maker's lockup, at the foot of the screens that carry no application chrome (sign-in, the platform
// console's sign-in). The product's own logo sits at the top of those screens; this is who makes it,
// in JBR Consulting's own lockup rather than words set in the page's type.
export function BrandFoot() {
  return (
    <footer className="brand-foot">
      <img src="/brand/lockup-light.png" alt="A product by JBR Consulting" />
    </footer>
  );
}
