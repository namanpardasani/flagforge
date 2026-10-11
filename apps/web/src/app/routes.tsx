import { Navigate, type RouteObject } from "react-router";
import { paths } from "@/components/shell/use-scope";
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
  { path: "/", hydrateFallbackElement, lazy: async () => ({ Component: (await dashboard()).HomeRedirect }) },
  { path: paths.login, hydrateFallbackElement, lazy: async () => ({ Component: (await dashboard()).LoginPage }) },
  { path: paths.register, hydrateFallbackElement, lazy: async () => ({ Component: (await dashboard()).RegisterPage }) },
  { path: paths.forgotPassword, hydrateFallbackElement, lazy: async () => ({ Component: (await dashboard()).ForgotPasswordPage }) },
  { path: paths.resetPassword, hydrateFallbackElement, lazy: async () => ({ Component: (await dashboard()).ResetPasswordPage }) },
  { path: paths.verifyEmail, hydrateFallbackElement, lazy: async () => ({ Component: (await dashboard()).VerifyEmailPage }) },
  { path: paths.welcome, hydrateFallbackElement, lazy: async () => ({ Component: (await dashboard()).WelcomePage }) },
  { path: "/w/:workspaceSlug", hydrateFallbackElement, lazy: async () => ({ Component: (await dashboard()).WorkspaceIndex }) },
  {
    path: "/w/:workspaceSlug/p/:projectKey",
    hydrateFallbackElement,
    lazy: async () => ({ Component: (await dashboard()).AppShell }),
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      { path: "flags/:flagKey", lazy: async () => ({ Component: (await dashboard()).FlagDetailPage }) },
      { path: "experiments/:experimentId", lazy: async () => ({ Component: (await dashboard()).ExperimentDetailPage }) },
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
