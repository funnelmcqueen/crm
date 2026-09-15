import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const RULE = "@typescript-eslint/no-restricted-imports";
const CODE_FILES = ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];

const voiceSdk = {
  paths: [
    {
      name: "@twilio/voice-sdk",
      message: "Only src/lib/dialer/drivers/twilio.ts may import the Twilio Voice SDK (ARCHITECTURE golden rule 7).",
    },
  ],
  patterns: [
    {
      regex: "^@twilio/voice-sdk/",
      message: "Only src/lib/dialer/drivers/twilio.ts may import the Twilio Voice SDK (ARCHITECTURE golden rule 7).",
    },
  ],
};

const twilioNode = {
  paths: [
    {
      name: "twilio",
      message: "The twilio Node library may only be imported under src/server/twilio/**, scripts/** or tests/**.",
    },
  ],
  patterns: [
    {
      regex: "^twilio/",
      message: "The twilio Node library may only be imported under src/server/twilio/**, scripts/** or tests/**.",
    },
  ],
};

// Client-reachable code must not pull in server modules. Server actions ('use server') and
// type-only imports are fine: the bundler replaces actions with references and types are erased.
const serverFromClient = {
  paths: [{ name: "server-only", message: "src/components/** and src/lib/** can be bundled for the browser." }],
  patterns: [
    {
      regex: "^(?:@|\\.{1,2})/(?:[^/]+/)*server/(?!actions(?:/|$))",
      allowTypeImports: true,
      message: "Do not import src/server/** from src/components/** or src/lib/** (server actions and types are allowed).",
    },
  ],
};

const servicesNoNext = {
  paths: [],
  patterns: [
    {
      regex: "^next(?:/|$)",
      message: "Services take an explicit context and must not import next/* (ARCHITECTURE golden rule 9).",
    },
  ],
};

function restrict(...groups) {
  return [
    "error",
    {
      paths: groups.flatMap((group) => group.paths),
      patterns: groups.flatMap((group) => group.patterns),
    },
  ];
}

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Later blocks replace the rule options of earlier ones for the files they match.
  { files: CODE_FILES, rules: { [RULE]: restrict(voiceSdk, twilioNode) } },
  { files: ["src/components/**", "src/lib/**"], rules: { [RULE]: restrict(voiceSdk, twilioNode, serverFromClient) } },
  { files: ["src/lib/dialer/drivers/twilio.ts"], rules: { [RULE]: restrict(twilioNode, serverFromClient) } },
  { files: ["src/server/twilio/**", "scripts/**", "tests/**"], rules: { [RULE]: restrict(voiceSdk) } },
  { files: ["src/server/services/**"], rules: { [RULE]: restrict(voiceSdk, twilioNode, servicesNoNext) } },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    ".localbase/**",
    "playwright-report/**",
    "test-results/**",
    "blob-report/**",
    "src/lib/database.types.ts",
  ]),
]);

export default eslintConfig;
