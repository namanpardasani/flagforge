import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/toaster";
import { flash, TAG_MS, useFlash } from "./flash";
import { dismissToast, toast } from "./toasts";

afterEach(() => vi.useRealTimers());

describe("flash store", () => {
  it("re-renders only the row that flashed", () => {
    const renders: Record<string, number> = { a: 0, b: 0 };
    function Row({ id }: { id: string }) {
      const current = useFlash(id);
      renders[id] = (renders[id] ?? 0) + 1;
      return <p data-testid={id}>{current?.kind ?? "none"}</p>;
    }
    render(
      <>
        <Row id="a" />
        <Row id="b" />
      </>,
    );
    const before = { ...renders };

    act(() => flash("a", "remote"));
    expect(screen.getByTestId("a")).toHaveTextContent("remote");
    expect(renders.a).toBeGreaterThan(before.a!);
    expect(renders.b).toBe(before.b); // the other row did not render at all
  });

  it("clears itself after the tag time, unless a newer flash replaced it", () => {
    vi.useFakeTimers();
    function Row() {
      return <p data-testid="row">{useFlash("a")?.kind ?? "none"}</p>;
    }
    render(<Row />);

    act(() => flash("a", "local"));
    act(() => void vi.advanceTimersByTime(TAG_MS - 1000));
    act(() => flash("a", "kill")); // a second flash restarts the clock
    act(() => void vi.advanceTimersByTime(1500));
    expect(screen.getByTestId("row")).toHaveTextContent("kill"); // the first timer did not remove the newer flash
    act(() => void vi.advanceTimersByTime(TAG_MS));
    expect(screen.getByTestId("row")).toHaveTextContent("none");
  });
});

describe("toast store", () => {
  it("shows a toast, keeps at most four, and removes one when dismissed", async () => {
    render(<Toaster />);
    let first = 0;
    act(() => {
      first = toast("one");
      for (const title of ["two", "three", "four", "five"]) toast(title);
    });
    expect(screen.queryByText("one")).not.toBeInTheDocument(); // the oldest made room
    expect(screen.getByText("five")).toBeInTheDocument();
    expect(first).toBeGreaterThan(0);

    let last = 0;
    act(() => void (last = toast("six", { detail: "with detail", tone: "danger" })));
    expect(screen.getByText("with detail")).toBeInTheDocument();
    act(() => dismissToast(last));
    await waitFor(() => expect(screen.queryByText("six")).toBeNull()); // it animates out first
  });
});
