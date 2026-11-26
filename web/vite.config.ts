import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
const integrationManifest = new URL("../custom_components/mech/manifest.json", import.meta.url);
const hacs = existsSync(integrationManifest);
const metadata = JSON.parse(readFileSync(hacs ? integrationManifest : new URL("../package.json", import.meta.url), "utf8"));
export default defineConfig({
  define: { __MECH_APP_INFO__: JSON.stringify({name: hacs ? "Mech-HACS" : "Mech", version: metadata.version}) },
  resolve: {
    extensions: [".web.tsx", ".tsx", ".web.ts", ".ts", ".web.js", ".js", ".mjs", ".json"],
    dedupe: ["react", "react-dom", "react-native-web", "react-native-svg"],
    // Package-root aliases prevent dependency optimization from fabricating
    // react-native-web/Libraries/... paths for native subpaths.
    alias: [
      {
        find: /^.*\/fabric\/NativeSvgSoundModule(?:\.js)?$/,
        replacement: fileURLToPath(new URL("./svgTouchSound.web.ts", import.meta.url)),
      },
      {
        find: /^@react-native\/assets-registry\/registry$/,
        replacement: fileURLToPath(
          new URL(
            "./node_modules/react-native-web/dist/modules/AssetRegistry/index.js",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^react-native-svg$/,
        replacement: fileURLToPath(
          new URL("./node_modules/react-native-svg/lib/module/elements.web.js", import.meta.url),
        ),
      },
      {
        find: /^react-native$/,
        replacement: fileURLToPath(
          new URL("./node_modules/react-native-web/dist/index.js", import.meta.url),
        ),
      },
    ],
  },
  optimizeDeps: {
    rolldownOptions: {
      plugins: [
        {
          name: "svg-browser-touch-sound",
          load(id) {
            // Rolldown resolves CommonJS require() edges before Vite aliases.
            if (id.endsWith("/react-native-svg/lib/module/fabric/NativeSvgSoundModule.js"))
              return "export default {playTouchSound(){throw new Error('Native touch sound is unavailable on web')}}";
          },
        },
      ],
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: { usePolling: true, interval: 250 },
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
  build: { target: "es2022" },
});
