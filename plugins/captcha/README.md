# Captcha

Puts a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) or [hCaptcha](https://www.hcaptcha.com/) check
on the sign-in forms: the email link, the password form and single sign-on. It slows down bots that send sign-in emails
or guess passwords in bulk.

The plugin only shows the widget. **Supabase Auth verifies the token** with the provider before it sends a link or
signs anyone in, using the secret key you give it. So:

- the secret never reaches Bogey or the browser, and
- nobody can skip the check by calling Supabase's auth API directly with the public key, which a check in Bogey alone
  couldn't stop.

Signing in with Google, GitHub and the other providers isn't checked; those providers do their own bot checks.

## Setting it up

Do it in this order. If Supabase starts asking for a token before the widget shows, nobody can sign in.

1. **Make a widget** with your provider and note its site key and secret key. Add your Bogey domain (and `localhost` for
   development) as an allowed hostname.
   - Turnstile: Cloudflare dashboard → Turnstile → Add widget. _Managed_ mode is a good default.
   - hCaptcha: dashboard → Sites → New site.
2. **Install the plugin**, rebuild and redeploy: `bogey plugins add captcha`.
3. **Set the provider and site key** in Instance → Plugins → Captcha. The widget now shows on the sign-in forms, but
   nothing checks it yet.
4. **Turn on captcha protection in Supabase** with the same provider and the secret key:
   - Supabase Cloud: Authentication → Attack Protection (or _Bot and Abuse Protection_) → Enable captcha protection.
   - Self-hosted Supabase: set `GOTRUE_SECURITY_CAPTCHA_ENABLED=true`, `GOTRUE_SECURITY_CAPTCHA_PROVIDER=turnstile` (or
     `hcaptcha`) and `GOTRUE_SECURITY_CAPTCHA_SECRET=<secret>` on the auth container, then restart it.
   - The Supabase CLI's local stack: `[auth.captcha]` in `supabase/config.toml`.
5. **Sign in in a private window** to check it works.

To turn it off, go in reverse: switch off Supabase's captcha protection first, then disable or remove the plugin.

## What people see

The widget sits above the sign-in button. Turnstile's managed mode usually passes without a click. Each token works once,
so the widget resets after every try. If it couldn't load (most often because a content blocker blocked the
provider's script), people are told which address to allow. If someone submits before it passes, Supabase refuses
and they're asked to complete the check.

Any `Content-Security-Policy` in front of Bogey must allow the provider: `script-src` and `frame-src` for
`https://challenges.cloudflare.com`, or `https://hcaptcha.com https://*.hcaptcha.com`.

## Settings

Both are locked to the instance, since Supabase Auth has one captcha configuration for the whole instance.

| Setting  | What it does                                                         |
| -------- | -------------------------------------------------------------------- |
| Provider | Cloudflare Turnstile or hCaptcha. Must match Supabase's.             |
| Site key | The widget's public key. Until it's set, the plugin shows nothing.   |
