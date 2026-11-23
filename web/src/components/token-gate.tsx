import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { setToken } from "@/lib/api";

/** Shown when the API answers 401: ask for the token once, keep it in localStorage. */
export const TokenGate = ({ rejected, onSaved }: { rejected: boolean; onSaved: () => void }) => {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setToken(value.trim());
    onSaved();
  };
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> Access token
          </CardTitle>
          <CardDescription>
            {rejected
              ? "That token was rejected. Enter the current GENE_UI_TOKEN."
              : "This Gene instance needs a token (GENE_UI_TOKEN). It's saved in this browser."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex gap-2">
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="Token"
              className="border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full min-w-0 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
            />
            <Button type="submit">Open</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
