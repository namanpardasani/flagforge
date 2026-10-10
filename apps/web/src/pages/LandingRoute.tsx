import { lazy, Suspense } from "react";

// Loaded only when someone opens /landing, so Lenis never ships with the dashboard.
const LandingPage = lazy(() => import("./Landing"));

export function LandingRoute() {
  return (
    <Suspense fallback={<div className="h-dvh bg-canvas" />}>
      <LandingPage />
    </Suspense>
  );
}
