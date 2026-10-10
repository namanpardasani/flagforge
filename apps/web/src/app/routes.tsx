import { Navigate, type RouteObject } from "react-router";
import { DEFAULT_SCOPE, paths } from "@/components/shell/use-scope";
import { LandingRoute } from "@/pages/LandingRoute";

/**
 * The dashboard and the landing page are separate downloads. Every dashboard route below loads
 * the same file (./dashboard) through the router's `lazy`, so the browser fetches the dashboard
 * once, the first time any of its screens is opened, and the landing page does not pay for it.
 * The router waits for the download before it switches screens, so there is no loading flash.
 */
const dashboard = () => import("./dashboard");

/** Shown while the dashboard code downloads on a first visit: the page colour, so nothing flashes. */
const hydrateFallbackElement = <div className="h-dvh bg-canvas" />;

/**
 * The route table, as plain data so tests can load the same routes into an in-memory router.
 * The page is a URL parameter (":page"), which lets one layout animate between every screen.
 */
export const routes: RouteObject[] = [
  { path: "/", element: <Navigate to={paths.project(DEFAULT_SCOPE.workspaceSlug, DEFAULT_SCOPE.projectKey)} replace /> },
  { path: "/w/:workspaceSlug", hydrateFallbackElement, lazy: async () => ({ Component: (await dashboard()).WorkspaceIndex }) },
  {
    path: "/w/:workspaceSlug/p/:projectKey",
    hydrateFallbackElement,
    lazy: async () => ({ Component: (await dashboard()).AppShell }),
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      { path: "flags/:flagKey", lazy: async () => ({ Component: (await dashboard()).FlagDetailPage }) },
      { path: ":page", lazy: async () => ({ Component: (await dashboard()).ProjectPage }) },
    ],
  },
  {
    path: "/kit",
    hydrateFallbackElement,
    lazy: async () => {
      const { AppShell } = await dashboard();
      return { element: <AppShell crumbs={[{ label: "Reference", to: paths.kit }, { label: "UI kit", current: true }]} /> };
    },
    children: [{ index: true, lazy: async () => ({ Component: (await dashboard()).KitPage }) }],
  },
  { path: "/landing", element: <LandingRoute /> },
  { path: "*", hydrateFallbackElement, lazy: async () => ({ Component: (await dashboard()).NotFound }) },
];
