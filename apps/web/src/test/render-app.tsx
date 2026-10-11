import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Providers } from "@/app/Providers";
import { routes } from "@/app/routes";
import type { EnvKey, Role } from "@/api/types";
import { server } from "./setup";

/**
 * Mounts the real app (real routes, real providers, the in-memory test server) at a URL.
 * By default the visitor is already signed in as the owner of the Halden workspace; `role` changes
 * what the server lets them do there, and `signedIn: false` starts with no session.
 * Async because the dashboard is a lazily loaded route: this resolves once the first screen is mounted.
 */
export async function renderApp(url = "/w/halden/p/dispatch-api/overview", options: { env?: EnvKey; role?: Role; signedIn?: boolean; settle?: boolean } = {}) {
  if (options.env) window.localStorage.setItem("ff.env", options.env);
  if (options.role) server.setRole("halden", options.role);
  if (options.signedIn !== false) server.signIn();
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
  // By default, also wait for the session check and the first data to arrive, so a test starts
  // from a loaded screen. `settle: false` returns earlier, for tests about the loading state itself.
  if (options.settle !== false) await act(() => server.whenIdle());
  return { router, user: userEvent.setup() };
}

export const FLAGS_URL = "/w/halden/p/dispatch-api/flags";
export const flagUrl = (key: string) => `${FLAGS_URL}/${key}`;
