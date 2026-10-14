import { useEffect, useRef, useState } from "react";
import { definePluginRuntime, type PluginAuthCaptchaContext } from "@bogey/plugins/runtime";
import type { SettingsOf } from "@bogey/plugins/types";
import { manifest } from "./manifest.ts";

type Settings = SettingsOf<typeof manifest>;
type Provider = Settings["provider"];

// the part of the Turnstile and hCaptcha APIs used here, which they share
interface WidgetOptions {
  sitekey: string;
  theme: "light" | "dark";
  size?: "flexible";
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => boolean;
}

interface WidgetApi {
  render: (element: HTMLElement, options: WidgetOptions) => string;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: WidgetApi;
    hcaptcha?: WidgetApi;
  }
}

const SCRIPTS: Record<Provider, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  hcaptcha: "https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off",
};

const loading = new Map<Provider, Promise<WidgetApi>>();

function api(provider: Provider): WidgetApi | undefined {
  return provider === "turnstile" ? window.turnstile : window.hcaptcha;
}

function load(provider: Provider): Promise<WidgetApi> {
  const ready = api(provider);
  if (ready) return Promise.resolve(ready);
  const cached = loading.get(provider);
  if (cached) return cached;
  const promise = new Promise<WidgetApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPTS[provider];
    script.async = true;
    script.onload = () => {
      const loaded = api(provider);
      if (loaded) resolve(loaded);
      else reject(new Error(`${provider} loaded without its API`));
    };
    script.onerror = () => reject(new Error(`couldn't load ${provider}`));
    document.head.append(script);
  });
  // a blocked script can be retried on the next mount
  promise.catch(() => loading.delete(provider));
  loading.set(provider, promise);
  return promise;
}

function Captcha({ settings, onToken }: PluginAuthCaptchaContext<Settings>) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const { provider, siteKey } = settings;

  useEffect(() => {
    const element = box.current;
    if (!element || !siteKey) return;
    let gone = false;
    let rendered: { api: WidgetApi; id: string } | undefined;

    load(provider)
      .then((widgets) => {
        if (gone) return;
        const id = widgets.render(element, {
          sitekey: siteKey,
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
          ...(provider === "turnstile" ? { size: "flexible" as const } : {}),
          callback: (token) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => {
            onToken(null);
            return true;
          },
        });
        rendered = { api: widgets, id };
      })
      .catch((error: unknown) => {
        console.error("[captcha]", error);
        if (!gone) setFailed(true);
      });

    return () => {
      gone = true;
      onToken(null);
      rendered?.api.remove(rendered.id);
    };
  }, [provider, siteKey, onToken]);

  if (!siteKey) return null;
  if (failed) {
    return (
      <p className="text-sm text-muted-fg">
        The sign-in check couldn't load. Allow {new URL(SCRIPTS[provider]).hostname} in your
        blocker, then reload the page.
      </p>
    );
  }
  return <div ref={box} className="min-h-16.25" />;
}

export default definePluginRuntime(manifest, {
  slots: { authCaptcha: Captcha },
});
