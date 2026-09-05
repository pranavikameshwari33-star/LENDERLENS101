import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Generated data and model artifacts. These are committed because the
    // application reads them at runtime, but they are outputs of the pipeline
    // rather than source, and linting a 9 MB JSON file is pure cost.
    "data/**",
    "ml/artifacts/**",
    "ml/data/**",

    // A Python prefix lives in the project directory (Lib/site-packages and the
    // pip shims under Scripts/), left over from inspecting the workbooks.
    "Lib/**",
    "Scripts/**",
  ]),
]);

export default eslintConfig;
