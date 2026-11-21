import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";

import { useAlertsStore } from "@/lib/alerts";
import { useSession } from "@/lib/auth/session";
import { setTokens } from "@/lib/auth/tokens";
import { resetDb } from "@/mocks/db";
import { server } from "@/mocks/server";

/*
 * jsdom : le `fetch` de Node ne sait pas sérialiser le FormData de jsdom. On encode donc le multipart
 * nous-mêmes, par-dessus le `fetch` intercepté par MSW (d'où l'installation après `server.listen`).
 */
async function encodeMultipart(form: FormData): Promise<{ body: Uint8Array; type: string }> {
  const boundary = `----tourneo${Math.random().toString(16).slice(2)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      chunks.push(
        encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
      );
    } else {
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(value);
      });
      chunks.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.name}"\r\nContent-Type: ${value.type || "application/octet-stream"}\r\n\r\n`,
        ),
        new Uint8Array(bytes),
        encoder.encode("\r\n"),
      );
    }
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}
function installFetch(): void {
  const intercepted = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.body instanceof FormData) {
      const { body, type } = await encodeMultipart(init.body);
      return intercepted(input, {
        ...init,
        body,
        headers: { ...(init.headers as Record<string, string>), "Content-Type": type },
      });
    }
    return intercepted(input, init);
  };
}

/* API du navigateur absentes de jsdom et attendues par Radix / dnd-kit. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
URL.createObjectURL ??= vi.fn(() => "blob:tourneo-test");
URL.revokeObjectURL ??= vi.fn();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  installFetch();
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetDb();
  setTokens(null);
  useSession.setState({ status: "anonymous", user: null, expired: false });
  useAlertsStore.setState({ bySource: {} });
  window.localStorage.clear();
});
afterAll(() => server.close());
