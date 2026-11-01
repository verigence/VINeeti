import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, errorMessage } from "../api";
import { StatusBars } from "../components/AppBars";
import { BrandFoot } from "../components/Brand";
import { useToast } from "../components/Toast";
import { Button, Card, Disclosure, Field, Notice, PasswordInput } from "../components/ui";
import { personName } from "../labels";
import { PRODUCT, productName } from "../product";
import { useSession } from "../session";

const DEALER_KEY = "dealer-code";
const MOBILE_KEY = "sign-in-mobile";

function recall(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
/** Remembering the last mobile number and dealer code on this device is a convenience only. */
function remember(dealer: string, mobile: string) {
  try {
    if (dealer) window.localStorage.setItem(DEALER_KEY, dealer);
    else window.localStorage.removeItem(DEALER_KEY);
    window.localStorage.setItem(MOBILE_KEY, mobile);
  } catch {
    // Private browsing: nothing is remembered.
  }
}

const passwordProblem = (pw: string) => (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw) ? "The password needs at least 8 characters, with a letter and a number." : null);

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <StatusBars />
      <div className="auth-middle">
        {/* One card: the logo and the sign-in belong to each other and are not two floating panels. */}
        <div className="auth-panel">
          <img src="/brand/wordmark.png" alt={PRODUCT} className="auth-lockup" />
          {children}
        </div>
      </div>
      <BrandFoot />
    </div>
  );
}

/** The dealer code is needed only when the same mobile number is registered at more than one dealership. */
function DealerCode({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Disclosure summary="Dealer code (only if asked)" open={Boolean(value)}>
      <Field label="Dealer code" hint="Leave blank unless your administrator gave you one.">
        <input value={value} onChange={(e) => onChange(e.target.value)} name="dealer" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="organization" inputMode="text" enterKeyHint="next" />
      </Field>
    </Disclosure>
  );
}

export function LoginScreen({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  // A dealership's own address says which dealership this is, so there is nothing to ask and nothing
  // to get wrong. On the shared address there is no answer here and the code is asked for as before.
  const [site, setSite] = useState<{ name: string; slug: string } | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    let live = true;
    void api
      .site()
      .then((r) => live && setSite(r.dealership ? { name: r.dealership.name, slug: r.dealership.slug } : null))
      .catch(() => undefined)
      .finally(() => live && setAsked(true));
    return () => {
      live = false;
    };
  }, []);
  const [dealer, setDealer] = useState(() => recall(DEALER_KEY));
  const [mobile, setMobile] = useState(() => recall(MOBILE_KEY));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const code = dealer.trim().toLowerCase();

  const signedIn = async () => {
    remember(code, mobile.trim());
    await onSignedIn();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!mobile.trim() || !password) {
      setError("Enter your mobile number and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.login(code, mobile.trim(), password);
      await signedIn();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (resetting) {
    return (
      <AuthFrame>
        <ResetPassword dealer={dealer} setDealer={setDealer} mobile={mobile} setMobile={setMobile} onBack={() => setResetting(false)} onSignedIn={signedIn} onOwnAddress={Boolean(site)} />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1>Sign in</h1>
        {site && <p className="auth-dealership">{site.name}</p>}
        <Field label="Mobile number" hint="Your mobile number is your ID.">
          <input value={mobile} onChange={(e) => setMobile(e.target.value)} name="username" type="tel" inputMode="numeric" autoComplete="username" enterKeyHint="next" autoFocus={!mobile} />
        </Field>
        <Field label="Password">
          <PasswordInput label="Password" value={password} onChange={setPassword} name="password" autoComplete="current-password" enterKeyHint="go" autoFocus={Boolean(mobile)} />
        </Field>
        {asked && !site && <DealerCode value={dealer} onChange={setDealer} />}
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" variant="primary" busy={busy} className="btn-block">
          Sign in
        </Button>
        <Button
          variant="ghost"
          className="btn-block"
          onClick={() => {
            setError(null);
            setResetting(true);
          }}
        >
          Set or reset password
        </Button>
      </form>
    </AuthFrame>
  );
}

/**
 * Setting a password without the old one: a 6-digit code goes to the person's own mobile on WhatsApp.
 * Where the dealership has not switched that on, the administrator resets the password instead.
 */
function ResetPassword({ dealer, setDealer, mobile, setMobile, onBack, onSignedIn, onOwnAddress }: { dealer: string; setDealer: (v: string) => void; mobile: string; setMobile: (v: string) => void; onBack: () => void; onSignedIn: () => Promise<void>; onOwnAddress?: boolean }) {
  const [step, setStep] = useState<"ask" | "code" | "admin">("ask");
  const [message, setMessage] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = dealer.trim().toLowerCase();

  const request = async () => {
    if (busy) return;
    if (mobile.replace(/\D/g, "").length < 10) return setError("Enter your 10-digit mobile number.");
    setBusy(true);
    setError(null);
    try {
      const options = await api.authOptions(slug, mobile.trim());
      if (!options.otp) {
        setStep("admin");
        return;
      }
      const res = await api.requestOtp(slug, mobile.trim());
      setMessage(res.message);
      setStep("code");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (busy) return;
    if (code.replace(/\D/g, "").length !== 6) return setError("Enter the 6-digit code.");
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    if (password !== again) return setError("The two passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      await api.resetWithOtp(slug, mobile.trim(), code.replace(/\D/g, ""), password);
      await onSignedIn();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const back = (
    <Button variant="ghost" className="btn-block" onClick={onBack} disabled={busy}>
      Back to sign in
    </Button>
  );

  if (step === "admin") {
    return (
      <div className="auth-card">
        <h1>Set or reset password</h1>
        <Notice>Ask your administrator to reset your password. You will be given a temporary password and asked to replace it when you sign in.</Notice>
        {back}
      </div>
    );
  }

  if (step === "code") {
    return (
      <form
        className="auth-card"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void reset();
        }}
      >
        <h1>Enter the code</h1>
        <Notice>{message}</Notice>
        <Field label="6-digit code">
          <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} name="one-time-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="mono" autoFocus />
        </Field>
        <Field label="New password" hint="At least 8 characters, with a letter and a number.">
          <PasswordInput label="New password" value={password} onChange={setPassword} name="new-password" autoComplete="new-password" />
        </Field>
        <Field label="New password again">
          <PasswordInput label="New password again" value={again} onChange={setAgain} name="new-password-again" autoComplete="new-password" />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" variant="primary" busy={busy} className="btn-block">
          Set password and sign in
        </Button>
        <Button
          variant="ghost"
          className="btn-block"
          disabled={busy}
          onClick={() => {
            setCode("");
            setError(null);
            setStep("ask");
          }}
        >
          Ask for a new code
        </Button>
        {back}
      </form>
    );
  }

  return (
    <form
      className="auth-card"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void request();
      }}
    >
      <h1>Set or reset password</h1>
      <Field label="Mobile number" hint="Your mobile number is your ID.">
        <input value={mobile} onChange={(e) => setMobile(e.target.value)} name="username" type="tel" inputMode="numeric" autoComplete="username" enterKeyHint="go" autoFocus={!mobile} />
      </Field>
      {!onOwnAddress && <DealerCode value={dealer} onChange={setDealer} />}
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" variant="primary" busy={busy} className="btn-block">
        Continue
      </Button>
      {back}
    </form>
  );
}

/** The password form, used both on its own page and on the forced first-sign-in screen. */
export function ChangePasswordForm({ forced }: { forced?: boolean }) {
  const { refresh } = useSession();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!current || !next) return setError("Enter your current password and a new password.");
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) return setError("The new password needs at least 8 characters, with a letter and a number.");
    if (next !== again) return setError("The two new passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      toast.ok("Password changed.");
      setCurrent("");
      setNext("");
      setAgain("");
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="form-stack">
      <Field label={forced ? "Password you were given" : "Current password"}>
        <PasswordInput label="Current password" value={current} onChange={setCurrent} name="current-password" autoComplete="current-password" autoFocus />
      </Field>
      <Field label="New password" hint="At least 8 characters, with a letter and a number.">
        <PasswordInput label="New password" value={next} onChange={setNext} name="new-password" autoComplete="new-password" />
      </Field>
      <Field label="New password again">
        <PasswordInput label="New password again" value={again} onChange={setAgain} name="new-password-again" autoComplete="new-password" />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {forced ? "Set password and continue" : "Change password"}
        </Button>
      </div>
    </form>
  );
}

/** Shown on its own, with nothing else reachable, until a first-time or reset password is replaced. */
export function ChangePasswordScreen() {
  const { me, signOut } = useSession();
  return (
    <div className="auth">
      <StatusBars />
      <div className="auth-middle">
        <div className="auth-panel">
          <div className="auth-brand">
            <img src="/brand/wordmark.png" alt={productName(me.app_name)} className="auth-wordmark" />
            <span className="auth-tagline">
              {me.tenant.name} · {me.tenant.oem}
            </span>
          </div>
          <Card title="Set a new password">
            <p className="lead">Welcome, {personName(me.user.name)}. Before you continue, replace the password you were given with one only you know.</p>
            <ChangePasswordForm forced />
            <div className="auth-foot">
              <Button variant="ghost" icon="logout" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          </Card>
        </div>
      </div>
      <BrandFoot />
    </div>
  );
}
