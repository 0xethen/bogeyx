import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconFileAlert,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { getPublicEnv } from "@bogey/db/env";
import type { PluginContext } from "@bogey/plugins/runtime";
import type { SettingsOf } from "@bogey/plugins/types";
import { Alert, AlertDescription, AlertTitle } from "@bogey/ui/components/alert";
import { Button } from "@bogey/ui/components/button";
import { ErrorAlert } from "@bogey/ui/components/error-alert";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@bogey/ui/components/field";
import { Input } from "@bogey/ui/components/input";
import { OptSelect } from "@bogey/ui/components/opt-select";
import { Screen } from "@bogey/ui/components/screen";
import { Switch } from "@bogey/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@bogey/ui/components/tabs";
import { useExternalValue } from "@bogey/ui/hooks/external";
import { useUnsavedEntry } from "@bogey/ui/lib/unsaved";
import {
  saveSebConfig,
  sebConfigQueryOptions,
  sebFileUrl,
  sebLinkQueryOptions,
  type SebConfigRow,
} from "./database.ts";
import { manifest } from "./manifest.ts";
import {
  donePath,
  readSebConfig,
  sebConfigKey,
  sebConfigSchema,
  sebLink,
  sebPlist,
  sebSettings,
  sha256Hex,
  type SebApp,
  type SebConfig,
  type SebRule,
  type SebTarget,
} from "./seb-config.ts";
import { SebKeys } from "./seb-keys.tsx";

type Settings = SettingsOf<typeof manifest>;

const never = () => () => undefined;
const currentOrigin = () => window.location.origin;

/** Manage → Lockdown Browser: which browser participants use, and Safe Exam Browser's setup. */
export function BrowserPage({ eventId, settings, settingsSections }: PluginContext<Settings>) {
  return (
    <Screen
      title="Lockdown Browser"
      description={<>The browser participants have to open the event in. <Link to={`/events/${eventId}/manage/security#lockdown.lockdown`} className="link">Configure Lockdown</Link></>}
      width="embedded"
    >
      {settingsSections}
      {settings.require === "seb" && <SebSetup eventId={eventId} />}
      {settings.require === "extension" && (
        <Screen.Section title="Lockdown extension">
          <p className="text-sm text-muted-fg">
            Build the Bogey lockdown companion for this site from the plugin's companion folder and
            give it to participants. It reports leaving the window and opening the developer tools.
          </p>
        </Screen.Section>
      )}
    </Screen>
  );
}

/** Where SEB opens (the event's home) and the hosts it must reach, from this browser's address. */
function useTarget(): SebTarget | null {
  const origin = useExternalValue(never, currentOrigin, "");
  const { slug } = useParams({ strict: false });
  if (!origin || !slug) return null;
  return {
    startUrl: `${origin}/events/${slug}`,
    quitUrl: `${origin}${donePath(slug)}`,
    hosts: [new URL(origin).host, new URL(getPublicEnv().supabaseUrl).host],
  };
}

async function buildFile(config: SebConfig, target: SebTarget) {
  const settings = sebSettings(config, target);
  return { config, plist: sebPlist(settings), configKey: await sebConfigKey(settings) };
}

function SebSetup({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient();
  const target = useTarget();
  const saved = useQuery(sebConfigQueryOptions(eventId));
  // here and not in the editor, which a save starts over
  const [tab, setTab] = useState("exam");
  const refresh = (row: SebConfigRow) => {
    queryClient.setQueryData(sebConfigQueryOptions(eventId).queryKey, row);
    return queryClient.invalidateQueries({ queryKey: sebLinkQueryOptions(eventId).queryKey });
  };
  // making it is creating something, so it has its own button; changes go through the save bar
  const create = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("Open this page from the event's address.");
      return saveSebConfig(eventId, await buildFile(readSebConfig({}), target));
    },
    onSuccess: refresh,
  });

  if (saved.isPending || !target) return null;
  if (!saved.data) {
    return (
      <Screen.Section
        title="Safe Exam Browser"
        description="Bogey writes the configuration file, serves it at a link that opens Safe Exam Browser, and checks that requests come from it. You can change what it allows after."
      >
        <Alert variant="destructive">
          <IconFileAlert />
          <AlertTitle>Nobody can open the event yet</AlertTitle>
          <AlertDescription>
            Safe Exam Browser is required, and without its configuration no browser passes the
            check, so participants stay covered until you set it up.
          </AlertDescription>
        </Alert>
        <ErrorAlert error={create.error} title="Couldn't set it up" />
        <div>
          <Button disabled={create.isPending} onClick={() => create.mutate()}>
            Set up Safe Exam Browser
          </Button>
        </div>
      </Screen.Section>
    );
  }
  // keyed by the save, so a fresh row starts a fresh draft
  return (
    <SebEditor
      key={saved.data.updated_at}
      eventId={eventId}
      row={saved.data}
      target={target}
      onSaved={refresh}
      tab={tab}
      onTabChange={setTab}
    />
  );
}

function SebEditor({
  eventId,
  row,
  target,
  onSaved,
  tab,
  onTabChange,
}: {
  eventId: string;
  row: SebConfigRow;
  target: SebTarget;
  onSaved: (row: SebConfigRow) => Promise<void>;
  tab: string;
  onTabChange: (tab: string) => void;
}) {
  const saved = readSebConfig(row.config);
  const [draft, setDraft] = useState<SebConfig>(saved);
  const [quitPassword, setQuitPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dirty = quitPassword !== "" || JSON.stringify(draft) !== JSON.stringify(saved);
  // the address it opens is part of the file: a new event address or site address needs a new file
  const current = sebPlist(sebSettings(saved, target)) === row.plist;

  const save = async (config: SebConfig): Promise<boolean> => {
    const parsed = sebConfigSchema.safeParse({
      ...config,
      quitPasswordHash: quitPassword ? await sha256Hex(quitPassword) : config.quitPasswordHash,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Something here can't be saved.");
      return false;
    }
    try {
      await onSaved(await saveSebConfig(eventId, await buildFile(parsed.data, target)));
      setError(null);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the configuration.");
      return false;
    }
  };

  useUnsavedEntry({
    dirty,
    reset: () => {
      setDraft(saved);
      setQuitPassword("");
    },
    save: () => save(draft),
  });

  const set = <K extends keyof SebConfig>(key: K, value: SebConfig[K]) =>
    setDraft((each) => ({ ...each, [key]: value }));
  const toggle = (key: BooleanKey<SebConfig>, label: string, description?: ReactNode) => (
    <Toggle
      id={`seb-${key}`}
      label={label}
      description={description}
      checked={draft[key]}
      onChange={(checked) => set(key, checked)}
    />
  );

  return (
    <Screen.Section
      title="Safe Exam Browser"
      description="What Safe Exam Browser allows while the event is open in it. Saving writes a new file; people already in it get the change the next time they open the link."
    >
      <ErrorAlert error={error} title="Couldn't save the configuration" />
      {!current && (
        <Alert variant="destructive">
          <IconFileAlert />
          <AlertTitle>SEB will open an old address!</AlertTitle>
          <AlertDescription>
            The event or this site has <strong>moved</strong> since the configuration file was
            written. Write it again so Safe Exam Browser opens {target.startUrl}.
          </AlertDescription>
          <div>
            <Button size="sm" variant="outline" onClick={() => void save(saved)}>
              Write it again
            </Button>
          </div>
        </Alert>
      )}
      <Tabs value={tab} onValueChange={(next: string) => onTabChange(next)}>
        <TabsList variant="line" className="w-full">
          <TabsTrigger value="exam">Exam</TabsTrigger>
          <TabsTrigger value="browser">Browser</TabsTrigger>
          <TabsTrigger value="sites">Sites</TabsTrigger>
          <TabsTrigger value="apps">Apps</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="exam" className="flex flex-col gap-8 pt-4">
          <ShareLink token={row.token} configKey={row.config_key} />
          <FieldGroup>
            {toggle(
              "allowQuit",
              "Let people quit (recommended)",
              "If disabled, only the quit password or link ends it.",
            )}
            <Field>
              <FieldLabel htmlFor="seb-quit-password">
                {draft.quitPasswordHash ? "New quit password" : "Quit password"}
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="seb-quit-password"
                  type="password"
                  autoComplete="new-password"
                  value={quitPassword}
                  maxLength={200}
                  onChange={(event) => setQuitPassword(event.target.value)}
                />
                {draft.quitPasswordHash && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      set("quitPasswordHash", "");
                      setQuitPassword("");
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <FieldDescription>
                {draft.quitPasswordHash
                  ? "A password is set. Proctors type it to let someone out early."
                  : "Proctors type it to let someone out early. Only its hash goes in the file."}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="seb-quit-url">Quit link</FieldLabel>
              <CopyInput id="seb-quit-url" value={target.quitUrl} label="the quit link" />
              <FieldDescription>
                Safe Exam Browser quits when it opens this address. The event opens it on its own
                once problems can't be submitted any more, and sends people to the scoreboard; you
                can also link to it, for example from the last problem.
              </FieldDescription>
            </Field>
            {toggle(
              "confirmQuit",
              "Ask before quitting from the link",
              "Also when problems close.",
            )}
          </FieldGroup>
          <SebKeys eventId={eventId} />
        </TabsContent>

        <TabsContent value="browser" className="pt-4">
          <FieldGroup>
            {toggle("showToolbar", "Show the toolbar", "Back, forward and the address.")}
            {toggle("allowReload", "Allow reloading")}
            {toggle("showTaskbar", "Show the taskbar", "Windows: the bar with the clock and quit.")}
            {toggle("showTime", "Show the time")}
            {toggle("allowZoom", "Allow zooming")}
            {toggle("allowSpellCheck", "Check spelling")}
            {toggle("allowDictionary", "Allow looking up words")}
            <Field orientation="horizontal" className="justify-between">
              <FieldContent>
                <FieldLabel htmlFor="seb-new-windows">Links that open a new window</FieldLabel>
              </FieldContent>
              <OptSelect
                id="seb-new-windows"
                className="w-56"
                value={draft.newWindows}
                onChange={(value) => set("newWindows", value)}
                options={[
                  { value: "new", label: "Open in a new window" },
                  { value: "same", label: "Open in the same window" },
                  { value: "block", label: "Don't open" },
                ]}
              />
            </Field>
            {toggle("allowDownloads", "Allow downloads and uploads")}
            {toggle("allowCamera", "Allow the camera")}
            {toggle("allowMicrophone", "Allow the microphone")}
            {toggle("muteAudio", "Mute sound when it starts")}
          </FieldGroup>
        </TabsContent>

        <TabsContent value="sites" className="flex flex-col gap-6 pt-4">
          <FieldGroup>
            {toggle(
              "filterUrls",
              "Only allow listed sites",
              "This site and its database are always allowed.",
            )}
            {draft.filterUrls &&
              toggle(
                "filterEmbedded",
                "Filter embedded content too",
                "Images, frames and scripts from other sites follow the list as well.",
              )}
          </FieldGroup>
          {draft.filterUrls && (
            <RuleList rules={draft.rules} onChange={(rules) => set("rules", rules)} />
          )}
        </TabsContent>

        <TabsContent value="apps" className="flex flex-col gap-8 pt-4">
          <FieldGroup>
            {toggle(
              "allowSwitching",
              "Allow switching to other apps",
              "Only the apps listed as allowed.",
            )}
          </FieldGroup>
          <AppList
            title="Allowed apps"
            description={
              draft.allowSwitching
                ? "Apps people can open from Safe Exam Browser, like a calculator or an editor."
                : "Turn on switching to other apps to let people open any."
            }
            disabled={!draft.allowSwitching}
            apps={draft.permittedApps}
            onChange={(apps) => set("permittedApps", apps)}
          />
          <AppList
            title="Apps to close"
            description="Safe Exam Browser closes these before it starts. Leave it empty to keep its own list; anything here replaces it."
            apps={draft.prohibitedApps}
            onChange={(apps) => set("prohibitedApps", apps)}
          />
        </TabsContent>

        <TabsContent value="security" className="pt-4">
          <FieldGroup>
            {toggle("allowVirtualMachine", "Allow virtual machines", "All platforms")}
            {toggle("allowScreenSharing", "Allow screen sharing", "macOS-only")}
            {toggle("allowScreenCapture", "Allow screenshots", "All platforms")}
            {toggle(
              "privateClipboard",
              "Keep the clipboard to itself",
              "Nothing copied before can be pasted in, and nothing copied in leaves.",
            )}
            {toggle("allowRightClick", "Allow right-click", "Desktop platforms")}
            {toggle("allowSiri", "Allow Siri", "macOS-only")}
            {toggle("allowDictation", "Allow dictation", "macOS-only")}
            {toggle("allowMirroring", "Allow mirroring the display", "macOS-only")}
            <Field orientation="horizontal" className="justify-between">
              <FieldContent>
                <FieldLabel htmlFor="seb-displays">Displays</FieldLabel>
                <FieldDescription>How many screens can be connected.</FieldDescription>
              </FieldContent>
              <OptSelect
                id="seb-displays"
                className="w-24"
                value={String(draft.maxDisplays)}
                onChange={(value) => set("maxDisplays", Number(value))}
                options={["1", "2", "3", "4"].map((value) => ({ value, label: value }))}
              />
            </Field>
          </FieldGroup>
        </TabsContent>
      </Tabs>
    </Screen.Section>
  );
}

type BooleanKey<T> = { [K in keyof T]: T[K] extends boolean ? K : never }[keyof T];

function Toggle({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="justify-between">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Field>
  );
}

/** The link participants open, the file behind it, and the Config Key the check accepts. */
function ShareLink({ token, configKey }: { token: string; configKey: string }) {
  const origin = useExternalValue(never, currentOrigin, "");
  const file = sebFileUrl(origin, token);
  const link = sebLink(file);
  return (
    <Field>
      <FieldLabel htmlFor="seb-link">Link that opens Safe Exam Browser</FieldLabel>
      <CopyInput id="seb-link" value={link} label="the link">
        <Button
          variant="outline"
          size="icon"
          aria-label="Download the file"
          title="Download the file"
          render={<a href={file} download="bogey.seb" />}
          nativeButton={false}
        >
          <IconDownload />
        </Button>
      </CopyInput>
      <FieldDescription>
        Participants who open the event in another browser get a button with this link. They sign in
        again inside Safe Exam Browser, with a code: an email link opens their usual browser. Anyone
        with the link can read the file and work out its Config Key (
        <code className="font-mono text-xs">{configKey.slice(0, 12)}…</code>), so it keeps people
        honest, not out.
      </FieldDescription>
    </Field>
  );
}

/** A read-only address with a button that copies it, and room for more buttons after. */
function CopyInput({
  id,
  value,
  label,
  children,
}: {
  id: string;
  value: string;
  label: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input id={id} readOnly value={value} className="font-mono" />
      <Button
        variant="outline"
        size="icon"
        aria-label={copied ? "Copied" : `Copy ${label}`}
        title={copied ? "Copied" : "Copy"}
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
        }
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </Button>
      {children}
    </div>
  );
}

const RULE_ACTIONS = [
  { value: "allow", label: "Allow" },
  { value: "block", label: "Block" },
] as const;

function RuleList({ rules, onChange }: { rules: SebRule[]; onChange: (rules: SebRule[]) => void }) {
  const update = (index: number, rule: SebRule) =>
    onChange(rules.map((each, at) => (at === index ? rule : each)));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-fg">
        An address like <code className="font-mono text-xs">docs.python.org</code> or{" "}
        <code className="font-mono text-xs">*.example.com/reference/*</code>; leaving out the scheme
        or the path matches any. A blocked address wins over an allowed one.
      </p>
      {rules.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rules.map((rule, index) => (
            <li key={index} className="flex flex-wrap items-center gap-2">
              <OptSelect
                ariaLabel="Allow or block"
                className="w-28"
                value={rule.action}
                options={RULE_ACTIONS}
                onChange={(action) => update(index, { ...rule, action })}
              />
              <Input
                aria-label="Address"
                className="min-w-48 flex-1 font-mono"
                value={rule.expression}
                maxLength={300}
                onChange={(event) => update(index, { ...rule, expression: event.target.value })}
              />
              <label className="flex items-center gap-2 text-sm text-muted-fg">
                <Switch
                  size="sm"
                  checked={rule.regex}
                  onCheckedChange={(regex) => update(index, { ...rule, regex })}
                />
                Regex
              </label>
              <RemoveButton onClick={() => onChange(rules.filter((_, at) => at !== index))} />
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...rules, { action: "allow", expression: "", regex: false }])}
        >
          <IconPlus /> Add an address
        </Button>
      </div>
    </div>
  );
}

const OS_OPTIONS = [
  { value: "windows", label: "Windows" },
  { value: "mac", label: "macOS" },
] as const;

function AppList({
  title,
  description,
  disabled = false,
  apps,
  onChange,
}: {
  title: string;
  description: string;
  /** Kept, but not written to the file: shown faded and can't be changed. */
  disabled?: boolean;
  apps: SebApp[];
  onChange: (apps: SebApp[]) => void;
}) {
  const update = (index: number, app: SebApp) =>
    onChange(apps.map((each, at) => (at === index ? app : each)));
  return (
    <fieldset
      disabled={disabled}
      aria-disabled={disabled}
      className="flex flex-col gap-3 transition-opacity disabled:opacity-50"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-sm text-muted-fg">{description}</p>
      </div>
      {apps.length > 0 && (
        <ul className="flex flex-col gap-2">
          {apps.map((app, index) => (
            <li key={index} className="flex flex-wrap items-center gap-2">
              <OptSelect
                ariaLabel="System"
                className="w-32"
                disabled={disabled}
                value={app.os}
                options={OS_OPTIONS}
                onChange={(os) => update(index, { ...app, os })}
              />
              <Input
                aria-label="Name"
                placeholder="Name"
                className="w-36"
                value={app.title}
                maxLength={80}
                onChange={(event) => update(index, { ...app, title: event.target.value })}
              />
              <Input
                aria-label="Program file"
                placeholder={
                  app.os === "mac" ? "/Applications/Calculator.app" : "C:\\Program Files\\calc.exe"
                }
                className="min-w-36 flex-1 font-mono"
                value={app.executable}
                maxLength={120}
                onChange={(event) => update(index, { ...app, executable: event.target.value })}
              />
              {app.os === "mac" && (
                <Input
                  aria-label="Bundle ID"
                  placeholder="com.apple.calculator"
                  className="min-w-44 flex-1 font-mono"
                  value={app.identifier}
                  maxLength={120}
                  onChange={(event) => update(index, { ...app, identifier: event.target.value })}
                />
              )}
              <RemoveButton onClick={() => onChange(apps.filter((_, at) => at !== index))} />
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([...apps, { os: "windows", title: "", executable: "", identifier: "" }])
          }
        >
          <IconPlus /> Add an app
        </Button>
      </div>
    </fieldset>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="text-destructive"
      aria-label="Remove"
      title="Remove"
      onClick={onClick}
    >
      <IconTrash />
    </Button>
  );
}
