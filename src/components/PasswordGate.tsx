import { useState, useCallback, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Lock } from "lucide-react";

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

  const handleSubmit = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    setError("");
    const hash = await hashPassword(password);
    if (hash === CORRECT_HASH) {
      sessionStorage.setItem("invoice_companion_auth", "granted");
      setAuthed(true);
    } else {
      setError("Incorrect password");
      setPassword("");
    }
    setChecking(false);
  }, [password, checking]);

  if (authed) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6 w-full max-w-sm px-6">
        <div className="flex flex-col items-center gap-3">
          <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
            <Lock className="h-7 w-7 text-primary" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-muted-foreground tracking-widest uppercase">
              NinetySix Shades
            </p>
            <h1 className="text-2xl font-bold text-foreground mt-1">
              Invoice Companion
            </h1>
          </div>
        </div>

        <form
          className="w-full flex flex-col gap-3"
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
            <p className="text-sm font-medium text-destructive text-center">
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
