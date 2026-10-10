// Everything the dashboard needs, re-exported from one file so it becomes ONE download.
// routes.tsx loads this lazily: a visitor who only sees the landing page never fetches it.
export { AppShell } from "@/components/shell/AppShell";
export { FlagDetailPage } from "@/pages/FlagDetail";
export { KitPage } from "@/pages/Kit";
export { NotFound, ProjectPage } from "@/pages/ProjectPage";
export { WorkspaceIndex } from "@/pages/WorkspaceIndex";
