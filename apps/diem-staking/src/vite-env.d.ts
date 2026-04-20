/// <reference types="vite/client" />

// Narrow the `import.meta.env` shape to the variables this app reads. Adding
// a typed field here (instead of relying on the generic `ImportMetaEnv`) gives
// us an autocomplete/typo-check benefit at the read site in `lib/addresses.ts`.
interface ImportMetaEnv {
  readonly VITE_DIEM_STAKING_PROXY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
