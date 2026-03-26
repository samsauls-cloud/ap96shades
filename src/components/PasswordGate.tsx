import { useState, useCallback, useEffect, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const CORRECT_HASH = "d081f92a51ef0e7ef430ab9e11917602aa18bfc9047cd0ef5e609436b8c06ea3";

async function hashPassword(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function PasswordGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(
    () => sessionStorage.getItem("invoice_companion_auth") === "granted"
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    setError("");
    const hash = await hashPassword(password);
    if (hash === CORRECT_HASH) {
      sessionStorage.setItem("invoice_companion_auth", "granted");
      setUnlocking(true);
    } else {
      setError("Incorrect password");
      setPassword("");
    }
    setChecking(false);
  }, [password, checking]);

  useEffect(() => {
    if (unlocking) {
      const timer = setTimeout(() => {
        setDismissed(true);
        setTimeout(() => setAuthed(true), 500);
      }, 1400);
      return () => clearTimeout(timer);
    }
  }, [unlocking]);

  if (authed) return <>{children}</>;

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-background transition-opacity duration-500 ${
        dismissed ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      <div className="flex flex-col items-center gap-8 w-full max-w-sm px-6">
        {/* 96 Logo Animation */}
        <div className="flex items-center justify-center select-none" aria-hidden>
          <span
            className="text-8xl font-black text-primary transition-all ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            style={{
              transform: unlocking
                ? "translateX(-40px) rotate(-15deg) scale(1.1)"
                : "translateX(0) rotate(0) scale(1)",
              opacity: unlocking ? 0.6 : 1,
              transitionDuration: "800ms",
            }}
          >
            9
          </span>
          <span
            className="text-8xl font-black text-primary transition-all ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            style={{
              transform: unlocking
                ? "translateX(40px) rotate(15deg) scale(1.1)"
                : "translateX(0) rotate(0) scale(1)",
              opacity: unlocking ? 0.6 : 1,
              transitionDuration: "800ms",
            }}
          >
            6
          </span>
        </div>

        {/* Unlock sparkle line between the digits */}
        <div
          className="h-[2px] bg-primary rounded-full transition-all ease-out"
          style={{
            width: unlocking ? "120px" : "0px",
            opacity: unlocking ? 1 : 0,
            transitionDuration: "600ms",
            transitionDelay: "200ms",
            boxShadow: unlocking
              ? "0 0 12px hsl(var(--primary)), 0 0 24px hsl(var(--primary) / 0.4)"
              : "none",
            marginTop: "-1.5rem",
          }}
        />

        <div className="text-center">
          <p className="text-sm font-medium text-muted-foreground tracking-widest uppercase">
            NinetySix Shades
          </p>
          <h1 className="text-xl font-bold text-foreground mt-1">
            Invoice Companion
          </h1>
        </div>

        {/* Form - hides during unlock */}
        <form
          className="w-full flex flex-col gap-3 transition-all duration-500"
          style={{
            opacity: unlocking ? 0 : 1,
            transform: unlocking ? "translateY(20px)" : "translateY(0)",
            pointerEvents: unlocking ? "none" : "auto",
          }}
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <Input
            type="password"
            placeholder="Enter password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            className="h-12 text-base"
          />
          {error && (
            <p className="text-sm font-medium text-destructive text-center animate-fade-in">
              {error}
            </p>
          )}
          <Button type="submit" disabled={checking || !password} className="h-11">
            Enter
          </Button>
        </form>
      </div>
    </div>
  );
}
