import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
export default defineConfig([...nextVitals, ...nextTs, globalIgnores(['.next/**', '.convex/**', 'next-env.d.ts']), {
  rules: { 'react-hooks/set-state-in-effect': 'off', 'react-hooks/refs': 'off' }
}]);
