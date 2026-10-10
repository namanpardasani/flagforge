import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Providers } from "@/app/Providers";
import { routes } from "@/app/routes";
import type { EnvKey } from "@/mocks/data";

/** Mounts the real app (real routes, real providers, mock server) at a URL, in a chosen environment. */
export function renderApp(url = "/w/halden/p/dispatch-api/overview", options: { env?: EnvKey } = {}) {
  if (options.env) window.localStorage.setItem("ff.env", options.env);
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup() };
}

export const FLAGS_URL = "/w/halden/p/dispatch-api/flags";
export const flagUrl = (key: string) => `${FLAGS_URL}/${key}`;
