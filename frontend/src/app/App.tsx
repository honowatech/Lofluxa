import { useEffect, useState } from "react";
import { RouterProvider } from "react-router-dom";

import { useSession } from "@/lib/auth/session";

import { AppProviders } from "./providers";
import { createRouter } from "./router";

export function App() {
  const [router] = useState(createRouter);
  const bootstrap = useSession((state) => state.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  return (
    <AppProviders>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AppProviders>
  );
}
