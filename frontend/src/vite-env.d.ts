/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCKS?: "off" | "partial" | "full";
  readonly VITE_TILES_URL?: string;
  readonly VITE_TILES_ATTRIBUTION?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
