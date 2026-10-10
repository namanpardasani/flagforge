import { Navigate, type RouteObject } from "react-router";
import { AppShell } from "@/components/shell/AppShell";
import { DEFAULT_SCOPE, paths } from "@/components/shell/use-scope";
import { FlagDetailPage } from "@/pages/FlagDetail";
import { KitPage } from "@/pages/Kit";
import { LandingRoute } from "@/pages/LandingRoute";
import { NotFound, ProjectPage } from "@/pages/ProjectPage";
import { WorkspaceIndex } from "@/pages/WorkspaceIndex";

/**
 * The route table, as plain data so tests can load the same routes into an in-memory router.
 * The page is a URL parameter (":page"), which lets one layout animate between every screen.
 */
export const routes: RouteObject[] = [
  { path: "/", element: <Navigate to={paths.project(DEFAULT_SCOPE.workspaceSlug, DEFAULT_SCOPE.projectKey)} replace /> },
  { path: "/w/:workspaceSlug", element: <WorkspaceIndex /> },
  {
    path: "/w/:workspaceSlug/p/:projectKey",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      { path: "flags/:flagKey", element: <FlagDetailPage /> },
      { path: ":page", element: <ProjectPage /> },
    ],
  },
  {
    path: "/kit",
    element: <AppShell crumbs={[{ label: "Reference", to: paths.kit }, { label: "UI kit", current: true }]} />,
    children: [{ index: true, element: <KitPage /> }],
  },
  { path: "/landing", element: <LandingRoute /> },
  { path: "*", element: <NotFound /> },
];
