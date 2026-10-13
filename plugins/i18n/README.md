# Languages

Shows Bogey in other languages. Bogey itself ships English; this plugin brings the translations, one catalog per language.
Spanish (`es`) is the first. A person picks theirs under Account → Preferences → Language (it appears once a plugin brings a
second language); otherwise Bogey uses what their browser asks for, and English where it has no match.

## When a message isn't translated

Under Instance → Extensions, **When a message isn't translated** (locked at the instance: organizations and events see the choice but can't change it) chooses what people see where their
language has no translation: English (the default), another language and then English, or the message's key (`nav.notifications`),
which is handy for finding what a translation still lacks. A key that exists nowhere, say a typo in the code, shows as itself and
never breaks a page.

## What is translated

The messages Bogey has been moved onto so far (Bogey's English messages are `packages/config/src/messages.ts`): the sign-in page, the header, and
the language setting. The rest of the app is being moved over directory by directory; Bogey's progress file lists what is
done. A message with no translation shows in English, so a partly translated language is still usable.

## Add a language

1. Copy `es.json` to `<code>.json` (a language tag such as `fr` or `pt-BR`) and translate the values. Keep the keys and
   keep every `{slot}` exactly as written; `{count, plural, one {# item} other {# items}}` takes the plural forms of your
   language (`one`, `few`, `many`, `other`, and `=0`), with `#` for the number.
2. Add `{ code: "fr", label: "Français" }` to `locales` in `manifest.ts`, and `fr: async () => (await import("./fr.json", { with: { type: "json" } })).default` to `catalogs` in `runtime.tsx`.
3. Add the same two lines to `tests/catalogs.test.ts`. It fails when a translation names a message that doesn't exist or
   changes a `{slot}`; it only warns, in the output of `untranslated`, about messages you haven't got to.
4. Rebuild Bogey. Languages are part of the build, like every plugin.

## Tests

`node --test tests/catalogs.test.ts`.
