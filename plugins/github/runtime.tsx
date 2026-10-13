import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { brand } from "@bogey/config";
import { stashRedirect } from "@bogey/db/auth";
import { browserClient } from "@bogey/db/browser";
import {
  mySubmissionsQueryOptions,
  saveSubmissionFn,
  type MySubmissions,
  type SubmissionItem,
} from "@bogey/db/queries/submissions";
import { definePluginRuntime, type PluginContext } from "@bogey/plugins/runtime";
import type { SettingsOf } from "@bogey/plugins/types";
import { DEFAULT_MAX_LENGTH } from "@bogey/utils/answers";
import { Button } from "@bogey/ui/components/button";
import { ErrorAlert } from "@bogey/ui/components/error-alert";
import { Panel } from "@bogey/ui/components/panel";
import { Screen } from "@bogey/ui/components/screen";
import { Switch } from "@bogey/ui/components/switch";
import { Textarea } from "@bogey/ui/components/textarea";
import {
  appFormOptions,
  errorVisibility,
  FieldSelect,
  rewardEarlyPunishLate,
  useAppForm,
} from "@bogey/ui/lib/form";
import {
  githubLogin,
  profileReadme,
  repoReadme,
  saveProfileReadme,
  type ProfileReadme,
} from "./api.ts";
import { answersOf, fit } from "./answers.ts";
import { client } from "./database.ts";
import { manifest } from "./manifest.ts";
import {
  parseRepo,
  projectsSection,
  replaceSection,
  summarize,
  toBase64,
  type Project,
} from "./readme.ts";

type Settings = SettingsOf<typeof manifest>;

/** The scope that lets Bogey edit a public repository, which a profile README is. */
const WRITE_SCOPE = "public_repo";

/** Query errors are typed `unknown`; ErrorAlert wants a message. */
function messageOf(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** What the browser holds from GitHub's sign-in: a token until Supabase next refreshes the session. */
async function loadConnection(): Promise<{ token: string | null; linked: boolean }> {
  const auth = browserClient().auth;
  const [{ data: session }, { data: identities }] = await Promise.all([
    auth.getSession(),
    auth.getUserIdentities(),
  ]);
  return {
    token: session.session?.provider_token ?? null,
    linked: identities?.identities.some((identity) => identity.provider === "github") ?? false,
  };
}

function Connect({ linked, connected }: { linked: boolean; connected: boolean }) {
  const connect = useMutation({
    mutationFn: async () => {
      // GitHub sends the browser back to the site root, which reads this
      stashRedirect(location.pathname);
      const options = { scopes: WRITE_SCOPE, redirectTo: `${location.origin}/` };
      const auth = browserClient().auth;
      const { error } = linked
        ? await auth.signInWithOAuth({ provider: "github", options })
        : await auth.linkIdentity({ provider: "github", options });
      if (error) throw error;
    },
  });
  return (
    <Panel
      title="Connect GitHub"
      description={
        connected
          ? "Connected. This lasts about an hour; connect again if publishing says it can't sign in."
          : "To edit your profile README, GitHub asks you to allow access to your public repositories. Bogey only uses it while this page is open and never stores it."
      }
    >
      <ErrorAlert error={messageOf(connect.error)} />
      <div>
        <Button variant="outline" disabled={connect.isPending} onClick={() => connect.mutate()}>
          {connected ? "Connect again..." : "Connect GitHub..."}
        </Button>
      </div>
    </Panel>
  );
}

function PublishReadme({
  eventId,
  settings,
  token,
  projects,
}: {
  eventId: string;
  settings: Settings;
  token: string;
  projects: readonly Project[];
}) {
  const [agreed, setAgreed] = useState(false);
  const [done, setDone] = useState(false);
  const preview = useQuery({
    queryKey: ["github", "profile-readme", token],
    queryFn: async (): Promise<{ login: string; readme: ProfileReadme | null }> => {
      const login = await githubLogin(token);
      return { login, readme: await profileReadme(token, login) };
    },
    retry: false,
  });
  const section = projectsSection(projects, settings.sectionTitle, brand.name);
  const next = preview.data?.readme ? replaceSection(preview.data.readme.text, section) : null;
  const publish = useMutation({
    mutationFn: async () => {
      const data = preview.data;
      if (!data?.readme || next === null) return;
      await saveProfileReadme(
        token,
        data.login,
        data.readme,
        next,
        `Update ${settings.sectionTitle} from ${brand.name}`,
        toBase64,
      );
      await client().rpc("log_event", { p_event: eventId, p_action: "github.readme_updated" });
    },
    onSuccess: () => setDone(true),
  });
  return (
    <Panel
      title="Publish to your profile"
      description="Adds a section to the README of your profile repository (the one named after you). Only the part between Bogey's markers changes."
    >
      <ErrorAlert error={messageOf(preview.error ?? publish.error)} />
      {preview.data && preview.data.readme === null && (
        <p className="text-sm text-muted-fg">
          {`You have no profile README yet. Create a public repository named ${preview.data.login} with a README, then come back.`}
        </p>
      )}
      {next !== null && (
        <>
          <Textarea
            readOnly
            rows={10}
            value={section}
            className="font-mono text-xs"
            aria-label="Preview of the section"
          />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={agreed} onCheckedChange={setAgreed} />
            {`Update ${preview.data?.login}/${preview.data?.login} on GitHub`}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={!agreed || publish.isPending || done || projects.length === 0}
              onClick={() => publish.mutate()}
            >
              Publish
            </Button>
            {projects.length === 0 && (
              <span className="text-sm text-muted-fg">Submit a project first.</span>
            )}
            {done && <span className="text-sm">Published.</span>}
          </div>
        </>
      )}
    </Panel>
  );
}

function usable(item: SubmissionItem, kinds: readonly string[]): boolean {
  return kinds.includes(item.kind);
}

const readmeSchema = z.object({
  address: z
    .string()
    .trim()
    .refine(
      (value) => parseRepo(value) !== null,
      "Paste a link like https://github.com/owner/repo.",
    )
    .meta({ label: "Repository address", placeholder: "https://github.com/owner/repo" }),
});

const fillSchema = z
  .object({
    form: z.string().meta({ label: "Form" }),
    into: z.string().meta({ label: "Put the description in" }),
    link: z.string().meta({ label: "Put the link in" }),
  })
  .refine((value) => value.into !== "" || value.link !== "", "Choose what to fill in.");

function ImportReadme({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient();
  const mine = useQuery(mySubmissionsQueryOptions(eventId));
  const [found, setFound] = useState<{ repo: Repo; readme: string } | null>(null);
  const [done, setDone] = useState(false);
  const read = useAppForm({
    ...appFormOptions.strictSchema({
      defaultValues: { address: "" },
      errorVisibility,
      validators: [rewardEarlyPunishLate(readmeSchema)],
    }),
    onSubmit: async ({ value, createValidationError }) => {
      const repo = parseRepo(value.address);
      if (!repo) return createValidationError("Paste a link like https://github.com/owner/repo.");
      const text = await repoReadme(repo.owner, repo.repo);
      if (text === null) {
        return createValidationError("That repository has no README, or it isn't public.");
      }
      setFound({ repo, readme: text });
      setDone(false);
      return undefined;
    },
  });
  const fill = useAppForm({
    ...appFormOptions.strictSchema({
      defaultValues: { form: "0", into: "", link: "" },
      errorVisibility,
      validators: [rewardEarlyPunishLate(fillSchema)],
    }),
    onSubmit: async ({ value, createValidationError }) => {
      const entry = mine.data?.forms[Number(value.form)];
      const submission = entry?.submission;
      if (!entry || !submission || !found) {
        return createValidationError("Start your submission first, then import.");
      }
      const answers = answersOf(submission.answers);
      const item = textItemsOf(entry).find((candidate) => candidate.key === value.into);
      if (item) {
        const limit =
          item.maxLength ??
          DEFAULT_MAX_LENGTH[
            item.kind === "text" ? "text" : item.kind === "longtext" ? "longtext" : "markdown"
          ];
        // a long answer takes the whole README as Markdown; a short one, a summary
        answers[item.key] = fit(
          item.kind === "markdown" ? found.readme : summarize(found.readme, limit),
          limit,
        );
      }
      const target = urlItemsOf(entry).find((candidate) => candidate.key === value.link);
      if (target) answers[target.key] = `https://github.com/${found.repo.owner}/${found.repo.repo}`;
      const saved = await saveSubmissionFn({
        data: {
          id: submission.id,
          title: submission.title,
          answers,
          isPublic: submission.is_public,
        },
      });
      if (!saved.ok) return createValidationError(saved.error.message);
      await client().rpc("log_event", { p_event: eventId, p_action: "github.imported" });
      await queryClient.invalidateQueries({
        queryKey: mySubmissionsQueryOptions(eventId).queryKey,
      });
      setDone(true);
      return undefined;
    },
  });
  const forms = mine.data?.forms ?? [];

  return (
    <Panel
      title="Fill in from a repository"
      description="Reads a public repository's README and puts a summary in your submission. Nothing is saved until you press Fill in, and you can edit it afterwards."
    >
      <read.AppForm>
        <read.Form className="flex flex-wrap items-start gap-2">
          <div className="min-w-64 flex-1">
            <read.Field name="address">
              {(field) => (
                <field.Field>
                  <field.TextInput type="url" autoComplete="off" aria-label="Repository address" />
                  <field.Error />
                </field.Field>
              )}
            </read.Field>
          </div>
          <read.Submit variant="outline" pending="Reading...">
            Read README
          </read.Submit>
        </read.Form>
        <read.FormAlert title="Couldn't read it" />
      </read.AppForm>
      <ErrorAlert error={messageOf(mine.error)} />
      {found && (
        <fill.AppForm>
          <fill.Form className="flex flex-col gap-3">
            <Textarea readOnly rows={6} value={summarize(found.readme)} aria-label="Summary" />
            {forms.length > 1 && (
              <fill.Field name="form">
                {(field) => (
                  <field.Field>
                    <field.Label />
                    <FieldSelect
                      field={field}
                      options={forms.map((each, index) => ({
                        value: String(index),
                        label: each.form.title,
                      }))}
                    />
                  </field.Field>
                )}
              </fill.Field>
            )}
            <fill.Subscribe selector={(state) => forms[Number(state.values.form)]}>
              {(entry) => (
                <>
                  <fill.Field name="into">
                    {(field) => (
                      <field.Field>
                        <field.Label />
                        <FieldSelect
                          field={field}
                          options={[
                            { value: "", label: "Don't fill a description" },
                            ...(entry ? textItemsOf(entry) : []).map((item) => ({
                              value: item.key,
                              label: item.label,
                            })),
                          ]}
                        />
                      </field.Field>
                    )}
                  </fill.Field>
                  <fill.Field name="link">
                    {(field) => (
                      <field.Field>
                        <field.Label />
                        <FieldSelect
                          field={field}
                          options={[
                            { value: "", label: "Don't fill a link" },
                            ...(entry ? urlItemsOf(entry) : []).map((item) => ({
                              value: item.key,
                              label: item.label,
                            })),
                          ]}
                        />
                      </field.Field>
                    )}
                  </fill.Field>
                </>
              )}
            </fill.Subscribe>
            <fill.FormAlert title="Couldn't fill it in" />
            <div>
              <fill.Subscribe selector={(state) => state.isSubmitting}>
                {(submitting) => (
                  <Button
                    type="button"
                    disabled={submitting}
                    confirm={{
                      title: "Fill in your submission?",
                      description: "This replaces what is in the chosen fields.",
                      label: "Fill in",
                      variant: "default",
                    }}
                    onClick={() => void fill.handleSubmit()}
                  >
                    Fill in...
                  </Button>
                )}
              </fill.Subscribe>
              {done && <span className="ml-3 text-sm">Done. Open your submission to see it.</span>}
            </div>
          </fill.Form>
        </fill.AppForm>
      )}
    </Panel>
  );
}

type FormEntry = MySubmissions["forms"][number];
type Repo = NonNullable<ReturnType<typeof parseRepo>>;

function textItemsOf(entry: FormEntry) {
  return entry.form.items.filter((item) => usable(item, ["text", "longtext", "markdown"]));
}

function urlItemsOf(entry: FormEntry) {
  return entry.form.items.filter((item) => usable(item, ["url"]));
}

function GithubPage({ eventId, settings }: PluginContext<Settings>) {
  const connection = useQuery({
    queryKey: ["github", "connection"],
    queryFn: loadConnection,
    retry: false,
  });
  const mine = useQuery(mySubmissionsQueryOptions(eventId));
  const projects: Project[] = (mine.data?.forms ?? []).flatMap(({ form, submission }) => {
    if (!submission || submission.status !== "submitted") return [];
    const urlItem = form.items.find((item) => item.kind === "url");
    const link = urlItem ? answersOf(submission.answers)[urlItem.key] : undefined;
    return [
      {
        title: submission.title || form.title,
        tagline: null,
        url: typeof link === "string" && link ? link : null,
      },
    ];
  });
  return (
    <Screen
      title="GitHub"
      description="Use your repositories with your submission and your profile."
    >
      <ErrorAlert error={messageOf(connection.error)} />
      <ImportReadme eventId={eventId} />
      {settings.writeReadme && (
        <>
          <Connect
            linked={connection.data?.linked ?? false}
            connected={connection.data?.token != null}
          />
          {connection.data?.token && (
            <PublishReadme
              eventId={eventId}
              settings={settings}
              token={connection.data.token}
              projects={projects}
            />
          )}
        </>
      )}
    </Screen>
  );
}

export default definePluginRuntime(manifest, { routes: { "": GithubPage } });
