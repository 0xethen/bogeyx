import { definePluginRuntime } from "@bogey/plugins/runtime";
import { manifest } from "./manifest.ts";

// one entry per language in the manifest; the catalog loads only when someone is using that language
export default definePluginRuntime(manifest, {
  catalogs: {
    es: async () => (await import("./es.json", { with: { type: "json" } })).default,
  },
});
