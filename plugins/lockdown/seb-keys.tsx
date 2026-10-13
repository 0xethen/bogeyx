import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { Button } from "@bogey/ui/components/button";
import { ErrorAlert } from "@bogey/ui/components/error-alert";
import { Field, FieldLabel } from "@bogey/ui/components/field";
import { Input } from "@bogey/ui/components/input";
import { OptSelect } from "@bogey/ui/components/opt-select";
import { Screen } from "@bogey/ui/components/screen";
import { saveSebKeys, sebKeysQueryOptions, type SebKeyKind } from "./database.ts";

const KINDS: { value: SebKeyKind; label: string }[] = [
  { value: "browser_exam", label: "Browser Exam Key" },
  { value: "config", label: "Config Key" },
];

const HEX_64 = /^[0-9a-fA-F]{64}$/;

/** The keys Safe Exam Browser's requests are checked against. Only proctors can read them. */
export function SebKeys({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient();
  const keys = useQuery(sebKeysQueryOptions(eventId));
  const [kind, setKind] = useState<SebKeyKind>("browser_exam");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const save = useMutation({
    mutationFn: (next: { kind: SebKeyKind; value: string; label: string }[]) =>
      saveSebKeys(eventId, next),
    onSuccess: () => {
      setValue("");
      setLabel("");
      return queryClient.invalidateQueries({ queryKey: sebKeysQueryOptions(eventId).queryKey });
    },
  });
  const current = (keys.data ?? []).map((key) => ({
    kind: key.kind,
    value: key.value,
    label: key.label,
  }));
  const valid = HEX_64.test(value.trim());

  return (
    <Screen.Section
      title="Safe Exam Browser keys"
      description="Safe Exam Browser sends a hash of each address it opens, made with its Browser Exam Key or Config Key (from the exam configuration). A request that matches one of these keys counts as coming from it. Anyone who knows a key can fake the hash, so keep them to proctors."
    >
      <ErrorAlert error={save.error} title="Couldn't save the keys" />
      {current.length === 0 ? (
        <p className="text-sm text-muted-fg">No keys yet. Nobody can pass the check.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border border-y border-border">
          {current.map((key) => (
            <li key={`${key.kind}-${key.value}`} className="flex items-center gap-3 py-2 text-sm">
              <span className="w-36 shrink-0 text-muted-fg">
                {KINDS.find((each) => each.value === key.kind)?.label}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{key.value}</code>
              {key.label && <span className="text-muted-fg">{key.label}</span>}
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-destructive"
                aria-label="Remove this key..."
                title="Remove..."
                disabled={save.isPending}
                confirm={{
                  title: "Remove this key?",
                  description: "Requests made with it stop passing the check.",
                  label: "Remove",
                }}
                onClick={() => save.mutate(current.filter((each) => each !== key))}
              >
                <IconTrash />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-48">
          <FieldLabel htmlFor="seb-kind">Kind</FieldLabel>
          <OptSelect
            id="seb-kind"
            value={kind}
            onChange={(next) => setKind(next === "config" ? "config" : "browser_exam")}
            options={KINDS}
          />
        </Field>
        <Field className="min-w-64 flex-1">
          <FieldLabel htmlFor="seb-value">Key (64 hex characters)</FieldLabel>
          <Input
            id="seb-value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="font-mono"
          />
        </Field>
        <Field className="w-40">
          <FieldLabel htmlFor="seb-label">Label</FieldLabel>
          <Input
            id="seb-label"
            value={label}
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <Button
          variant="outline"
          disabled={!valid || save.isPending}
          onClick={() => save.mutate([...current, { kind, value: value.trim(), label }])}
        >
          <IconPlus />
          Add key
        </Button>
      </div>
    </Screen.Section>
  );
}
