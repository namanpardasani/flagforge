import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Providers } from "@/app/Providers";
import { routes } from "@/app/routes";
import type { EnvKey } from "@/mocks/data";

/**
 * Mounts the real app (real routes, real providers, mock server) at a URL, in a chosen environment.
 * Async because the dashboard is a lazily loaded route: this resolves once the first screen is mounted.
 */
export async function renderApp(url = "/w/halden/p/dispatch-api/overview", options: { env?: EnvKey } = {}) {
  if (options.env) window.localStorage.setItem("ff.env", options.env);
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  // Resolve at the very moment the first route is ready (not on a polling interval), so a test
  // can still observe what the screen shows first, such as a loading skeleton.
  await act(
    () =>
      new Promise<void>((resolve) => {
        if (router.state.initialized) return resolve();
        const stop = router.subscribe((state) => {
          if (!state.initialized) return;
          stop();
          resolve();
        });
      }),
  );
  return { router, user: userEvent.setup() };
}

export const FLAGS_URL = "/w/halden/p/dispatch-api/flags";
export const flagUrl = (key: string) => `${FLAGS_URL}/${key}`;
