import { definePlugin } from "@bogey/plugins/api";

export const manifest = definePlugin({
  key: "captcha",
  name: "Captcha",
  api: 1,
  version: "1.0.0",
  description:
    "Puts a Cloudflare Turnstile or hCaptcha check on the sign-in forms, which Supabase Auth verifies before it sends a link or signs anyone in.",
  author: { name: "Ethen Tseggai", url: "https://github.com/0xethen" },
  license: "MIT",
  source: { repository: "github:0xethen/bogeyx", directory: "plugins/captcha" },
  // the secret key lives in Supabase Auth, never here
  settings: {
    provider: {
      type: "select",
      label: "Provider",
      description: "Use the same one as Supabase Auth's captcha protection.",
      default: "turnstile",
      lock: "instance",
      options: [
        { value: "turnstile", label: "Cloudflare Turnstile" },
        { value: "hcaptcha", label: "hCaptcha" },
      ],
    },
    siteKey: {
      type: "string",
      label: "Site key",
      description: "The public key of the widget. Nothing shows until it's set.",
      default: "",
      placeholder: "0x4AAAAAAA...",
      lock: "instance",
    },
  },
  uses: { network: ["challenges.cloudflare.com", "js.hcaptcha.com", "hcaptcha.com"] },
});

export default manifest;
